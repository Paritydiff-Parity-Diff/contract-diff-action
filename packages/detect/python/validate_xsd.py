import io
import json
import os
import pathlib
import re
import sys
import urllib.request
import urllib.response
import warnings
import hashlib
from xml.etree import ElementTree


def resource_limits():
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes

        size = ctypes.c_size_t
        class Basic(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
                        ('flags', wintypes.DWORD), ('min_ws', size), ('max_ws', size),
                        ('processes', wintypes.DWORD), ('affinity', size),
                        ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
        class Counters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in
                        ['read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes']]
        class Extended(ctypes.Structure):
            _fields_ = [('basic', Basic), ('io', Counters), ('memory', size),
                        ('job_memory', size), ('peak_memory', size), ('peak_job_memory', size)]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        job = kernel.CreateJobObjectW(None, None)
        limits = Extended()
        limits.basic.flags = 0x0002 | 0x0008 | 0x0100 | 0x2000
        limits.basic.process_time = 5 * 10000000
        limits.basic.processes = 1
        limits.memory = 512 * 1024 * 1024
        if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            raise RuntimeError('parser_isolation_unavailable')
        return job
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
    return None


def validate(data):
    job = resource_limits()
    import xmlschema
    import elementpath
    if xmlschema.__version__ != '4.3.2' or elementpath.__version__ != '5.1.4':
        raise RuntimeError('parser_version_mismatch')
    warnings.simplefilter('error')
    xmlschema.limits.MAX_XML_DEPTH = 100
    xmlschema.limits.MAX_XML_ELEMENTS = 100000
    xmlschema.limits.MAX_SCHEMA_SOURCES = 64
    base = pathlib.Path(data['directory']).resolve()
    allowed = {pathlib.Path(path).resolve() for path in data['files']}
    if not allowed or len(allowed) > 64 or any(not path.is_relative_to(base) or not path.is_file() or path.is_symlink() for path in allowed):
        raise RuntimeError('schema_bundle_invalid')
    for path in allowed:
        if re.search(r'<!\s*(DOCTYPE|ENTITY)\b', path.read_text(encoding='utf8'), re.I):
            raise RuntimeError('xml_entities_disabled')

    class FrozenFiles(urllib.request.FileHandler):
        def file_open(self, request):
            path = pathlib.Path(urllib.request.url2pathname(request.selector)).resolve()
            if request.host not in ('', 'localhost') or path not in allowed:
                raise RuntimeError('schema_source_not_captured')
            return urllib.response.addinfourl(io.BytesIO(path.read_bytes()), {}, request.full_url)

    opener = urllib.request.build_opener(FrozenFiles())
    def no_external_access(*args, **kwargs):
        raise RuntimeError('parser_external_access_disabled')
    urllib.request.urlopen = no_external_access
    import socket
    socket.create_connection = no_external_access
    constructor = xmlschema.XMLSchema11 if data['dialect'] == '1.1' else xmlschema.XMLSchema10
    try:
        schema = constructor(data['schema'], validation='strict', allow='sandbox', base_url=str(base),
                             defuse='always', opener=opener, use_fallback=False, use_cache=False,
                             use_meta=True, partial=False)
        if not schema.built or schema.warnings:
            raise RuntimeError('schema_validation_incomplete')
    except Exception:
        return {'available': False, 'valid': False, 'reason': 'schema_validation_failed'}
    encoding = data.get('soapEncoding')
    if encoding is not None and encoding not in ('http://schemas.xmlsoap.org/soap/encoding/', 'http://www.w3.org/2003/05/soap-encoding'):
        return {'available': False, 'valid': False, 'reason': 'soap_encoding_unavailable'}
    graph_values = data.get('graphReferences', {})
    if not isinstance(graph_values, dict) or len(graph_values) > 1000 or (graph_values and encoding is None):
        return {'available': False, 'valid': False, 'reason': 'xml_graph_context_invalid'}
    graph_attribute = '{urn:paritydiff:encoded-graph}ref'
    graph_documents, graph_seen, graph_pending = {}, set(), []
    from xmlschema.validators.validation import ValidationContext
    def resource(payload):
        if not isinstance(payload, str) or re.search(r'<!\s*(DOCTYPE|ENTITY)\b', payload, re.I):
            raise xmlschema.XMLSchemaValidationError(schema, payload, 'XML payload rejected')
        tree = data.get('xml11Infosets', {}).get(hashlib.sha256(payload.encode('utf8')).hexdigest())
        if tree is not None:
            count = 0
            def events(node, depth=0):
                nonlocal count
                count += 1
                if depth >= 99 or count >= 100000 or not isinstance(node, dict):
                    raise RuntimeError('xml11_infoset_invalid')
                element = ElementTree.Element(node['name'], dict(node['attributes']))
                for namespace in node['namespaces']:
                    yield 'start-ns', tuple(namespace)
                yield 'start', element
                previous = None
                for child in node['children']:
                    if isinstance(child, str):
                        if previous is None:
                            element.text = (element.text or '') + child
                        else:
                            previous.tail = (previous.tail or '') + child
                    else:
                        for event, value in events(child, depth + 1):
                            yield event, value
                            if event == 'end':
                                previous_child = value
                        previous = previous_child
                        element.append(previous)
                yield 'end', element
                for namespace in node['namespaces']:
                    yield 'end-ns', None
            def iterparse(source, requested_events):
                return (item for item in events(tree) if item[0] in requested_events)
            return xmlschema.XMLResource('<bridge/>', allow='none', defuse='always', timeout=1,
                                         iterparse=iterparse)
        return xmlschema.XMLResource(payload, allow='none', defuse='always', timeout=1)
    def prepare(document):
        metadata = {}
        if encoding:
            for element in document.root.iter():
                metadata[element] = {name: value for name, value in element.attrib.items() if name.startswith('{' + encoding + '}')}
                for name in metadata[element]:
                    del element.attrib[name]
        def encoded_type_rules(element, declaration):
            if encoding is None or element.get('{http://www.w3.org/2001/XMLSchema-instance}nil') in ('true', '1'):
                return
            array_type = schema.maps.types.get('{' + encoding + '}Array')
            actual_type = declaration.type
            value = element.get('{http://www.w3.org/2001/XMLSchema-instance}type')
            if value:
                parts = value.split(':')
                namespaces = document.get_nsmap(element) or {}
                name = '{' + namespaces.get(parts[0] if len(parts) == 2 else '', '') + '}' + parts[-1]
                actual_type = schema.maps.types.get(name[2:] if name.startswith('{}') else name) or actual_type
            if array_type is not None and actual_type.is_derived(array_type):
                attributes = metadata.get(element, {})
                if encoding.endswith('/soap/encoding/') and not attributes.get('{' + encoding + '}arrayType'):
                    raise xmlschema.XMLSchemaValidationError(declaration, element, 'SOAP arrayType is required')
                kind = attributes.get('{' + encoding + '}nodeType')
                if kind is not None and kind != 'array':
                    raise xmlschema.XMLSchemaValidationError(declaration, element, 'SOAP node type conflicts with Array')
        return encoded_type_rules
    if graph_values:
        try:
            for captured in schema.maps.iter_schemas():
                if captured.meta_schema is None or captured.target_namespace in ('http://www.w3.org/2001/XMLSchema', 'http://www.w3.org/2001/XMLSchema-instance'):
                    continue
                for node in captured.source.root.iter():
                    if node.tag in ['{http://www.w3.org/2001/XMLSchema}' + name for name in ('assert', 'assertion', 'key', 'keyref', 'unique', 'alternative')] or node.get('inheritable') in ('true', '1'):
                        return {'available': False, 'valid': False, 'reason': 'xml_graph_global_constraints_unavailable'}
                def global_type(value_type, seen=None):
                    if seen is None:
                        seen = set()
                    if value_type is None or id(value_type) in seen:
                        return False
                    seen.add(id(value_type))
                    if any(value_type.is_derived(schema.maps.types['{http://www.w3.org/2001/XMLSchema}' + name]) for name in ('ID', 'IDREF', 'IDREFS')):
                        return True
                    return global_type(getattr(value_type, 'item_type', None), seen) or any(global_type(member, seen) for member in getattr(value_type, 'member_types', []))
                for component in captured.iter_components():
                    value_type = getattr(component, 'type', None)
                    if global_type(value_type):
                        return {'available': False, 'valid': False, 'reason': 'xml_graph_global_constraints_unavailable'}
            for key, payload in graph_values.items():
                if not re.fullmatch(r'g[0-9]{1,4}', key) or not isinstance(payload, str) or len(payload.encode('utf8')) > 1024 * 1024:
                    raise RuntimeError('xml_graph_context_invalid')
                document = resource(payload)
                if graph_attribute in document.root.attrib:
                    raise RuntimeError('xml_graph_definition_invalid')
                graph_documents[key] = (document, prepare(document))
        except Exception:
            return {'available': False, 'valid': False, 'reason': 'xml_graph_context_invalid'}
    def graph_hook(element, declaration):
        ref = element.get(graph_attribute)
        if ref is None:
            return False
        if ref not in graph_documents or len(element) or (element.text and element.text.strip()):
            raise xmlschema.XMLSchemaValidationError(declaration, element, 'Invalid graph reference')
        target = graph_documents[ref][0].root
        if target.tag != element.tag or {name: value for name, value in element.attrib.items() if name != graph_attribute} != dict(target.attrib):
            raise xmlschema.XMLSchemaValidationError(declaration, element, 'Graph edge identity changed')
        key = (ref, id(declaration))
        if key not in graph_seen:
            if len(graph_seen) >= 1000:
                raise RuntimeError('xml_graph_obligation_limit')
            graph_seen.add(key)
            graph_pending.append((ref, declaration))
        return True
    def graph_validate():
        while graph_pending:
            ref, declaration = graph_pending.pop()
            document, rules = graph_documents[ref]
            context = ValidationContext(source=document, use_defaults=False, use_location_hints=False,
                                        validation_hook=graph_hook, extra_validator=rules)
            declaration.raw_decode(document.root, 'strict', context)
            if context.errors:
                raise xmlschema.XMLSchemaValidationError(declaration, document.root, 'Invalid graph node')
    checks = data.get('typeChecks', [])
    if not isinstance(checks, list) or len(checks) > 1000:
        return {'available': False, 'valid': False, 'reason': 'xml_type_checks_invalid'}
    try:
        for check in checks:
            if not isinstance(check, dict) or not isinstance(check.get('typeName'), str) or ('payload' in check and not isinstance(check['payload'], str)):
                raise RuntimeError('xml_type_checks_invalid')
            name = check['typeName']
            component = schema.maps.types.get(name[2:] if name.startswith('{}') else name)
            if component is None:
                return {'available': False, 'valid': False, 'reason': 'xml_type_context_unavailable'}
            actual_name = check.get('actualTypeName')
            if actual_name is not None:
                actual = schema.maps.types.get(actual_name[2:] if actual_name.startswith('{}') else actual_name)
                if actual is None:
                    return {'available': False, 'valid': False, 'reason': 'xml_type_context_unavailable'}
                if not actual.is_derived(component):
                    return {'available': True, 'valid': False, 'reason': 'xml_type_derivation_invalid'}
            if 'payload' not in check:
                continue
            if re.search(r'<!\s*(DOCTYPE|ENTITY)\b', check['payload'], re.I):
                return {'available': True, 'valid': False, 'reason': 'xml_payload_invalid'}
            document = resource(check['payload'])
            rules = prepare(document)
            element = schema.create_element(document.root.tag)
            element.type = component
            context = ValidationContext(source=document, check_identities=not graph_values, use_defaults=False, use_location_hints=False,
                                        validation_hook=graph_hook, extra_validator=rules)
            element.raw_decode(document.root, 'strict', context)
            graph_validate()
            if context.errors:
                return {'available': True, 'valid': False, 'reason': 'xml_instance_invalid'}
    except xmlschema.XMLSchemaValidationError:
        return {'available': True, 'valid': False, 'reason': 'xml_instance_invalid'}
    except Exception:
        return {'available': False, 'valid': False, 'reason': 'xml_type_validation_unavailable'}
    if 'payload' not in data:
        return {'available': True, 'valid': True, 'reason': 'schema_metaschema_validated', 'dialect': data['dialect']}
    payload = data['payload']
    if not isinstance(payload, str) or re.search(r'<!\s*(DOCTYPE|ENTITY)\b', payload, re.I):
        return {'available': True, 'valid': False, 'reason': 'xml_payload_invalid'}
    try:
        document = resource(payload)
        rules = prepare(document)
        schema.validate(document, use_location_hints=False, allow_empty=False, extra_validator=rules, validation_hook=graph_hook)
        graph_validate()
        if set(graph_values) - {key[0] for key in graph_seen}:
            return {'available': False, 'valid': False, 'reason': 'xml_graph_type_context_unavailable'}
        return {'available': True, 'valid': True, 'reason': 'xml_instance_validated', 'dialect': data['dialect']}
    except xmlschema.XMLSchemaValidationError:
        return {'available': True, 'valid': False, 'reason': 'xml_instance_invalid', 'dialect': data['dialect']}
    except Exception:
        return {'available': False, 'valid': False, 'reason': 'xml_validation_unavailable'}


try:
    raw = sys.stdin.buffer.read(21 * 1024 * 1024)
    if len(raw) > 20 * 1024 * 1024:
        raise RuntimeError('parser_input_limit')
    result = validate(json.loads(raw))
except Exception:
    result = {'available': False, 'valid': False, 'reason': 'xsd_parser_unavailable'}
sys.stdout.write(json.dumps(result))
