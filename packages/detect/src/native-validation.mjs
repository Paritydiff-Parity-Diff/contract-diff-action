import { gunzipSync, inflateSync } from 'node:zlib';
import { installScalarContracts } from './graphql-scalars.mjs';
import { validateGraphqlResponse } from './graphql-response.mjs';
import { grpcStatusCode, grpcStatusDetailsBytes } from '../../core/src/grpc-status.mjs';
import { validateProtobufWire } from './protobuf-wire.mjs';
import { validateAsyncapiPayload } from './asyncapi-binding.mjs';
import { validateKafkaPayload } from './asyncapi-kafka.mjs';
export async function validateNativePayload(input) {
  const document = input.native.document;
  const native = document?.['x-paritydiff-native-contract'],
    format = document?.['x-paritydiff-source-format'];
  const payload = input.payload;
  try {
    if (format === 'graphql') {
      const payload = input.direction === 'output' ? input.requestPayload : input.payload;
      const g = await import('graphql');
      const schema = native?.__schema ? g.buildClientSchema(native) : g.buildASTSchema(native);
      const scalarProfiles = installScalarContracts(
        document['x-paritydiff-graphql-scalar-contracts'],
        schema,
        g,
      );
      if (!payload || typeof payload.query !== 'string' || payload.query.length > 65536)
        return { available: true, valid: false, protocol: 'graphql' };
      const query = g.parse(payload.query, { maxTokens: 10000, noLocation: true });
      if (g.validate(schema, query).length)
        return { available: true, valid: false, protocol: 'graphql' };
      const operation = g.getOperationAST(query, payload.operationName);
      if (!operation) return { available: true, valid: false, protocol: 'graphql' };
      const coerced = g.getVariableValues(
        schema,
        operation.variableDefinitions ?? [],
        payload.variables ?? {},
        { maxErrors: 10 },
      );
      if (coerced.errors) return { available: true, valid: false, protocol: 'graphql' };
      const fragments = new Map(
        query.definitions
          .filter((node) => node.kind === 'FragmentDefinition')
          .map((node) => [node.name.value, node]),
      );
      const fields = new Set();
      let visited = 0;
      const rootFields = (selectionSet, seen = new Set()) => {
        if (++visited > 10000) throw new Error('graphql_selection_limit');
        for (const selection of selectionSet.selections) {
          const skipped = (selection.directives ?? []).some((directive) => {
            const valueNode = directive.arguments?.find(
              (argument) => argument.name.value === 'if',
            )?.value;
            const value =
              valueNode?.kind === 'Variable'
                ? coerced.variableValues.coerced[valueNode.name.value]
                : valueNode?.kind === 'BooleanValue'
                  ? valueNode.value
                  : undefined;
            return (
              (directive.name.value === 'skip' && value === true) ||
              (directive.name.value === 'include' && value === false)
            );
          });
          if (skipped) continue;
          if (selection.kind === 'Field')
            fields.add(
              '/graphql/' + operation.operation + '/' + encodeURIComponent(selection.name.value),
            );
          else if (selection.kind === 'InlineFragment') rootFields(selection.selectionSet, seen);
          else if (selection.kind === 'FragmentSpread' && !seen.has(selection.name.value)) {
            const fragment = fragments.get(selection.name.value);
            if (!fragment) throw new Error('graphql_fragment_missing');
            rootFields(fragment.selectionSet, new Set([...seen, selection.name.value]));
          }
        }
      };
      rootFields(operation.selectionSet);
      if (!input.native.operationPaths?.some((path) => fields.has(path)))
        return {
          available: true,
          valid: false,
          protocol: 'graphql',
          reason: 'graphql_operation_binding_mismatch',
        };
      const knownInputs = (type, seen = new Set()) => {
        const named = g.getNamedType(type);
        if (!named || seen.has(named.name)) return true;
        if (g.isScalarType(named))
          return g.isSpecifiedScalarType(named) || scalarProfiles.inputs.has(named.name);
        if (!g.isInputObjectType(named)) return true;
        seen.add(named.name);
        return Object.values(named.getFields()).every((field) => knownInputs(field.type, seen));
      };
      let inputsAvailable = (operation.variableDefinitions ?? []).every((variable) =>
        knownInputs(g.typeFromAST(schema, variable.type)),
      );
      const typeInfo = new g.TypeInfo(schema);
      g.visit(
        query,
        g.visitWithTypeInfo(typeInfo, {
          enter() {
            const type = typeInfo.getInputType();
            if (type && !knownInputs(type)) inputsAvailable = false;
          },
        }),
      );
      if (!inputsAvailable)
        return {
          available: false,
          valid: false,
          protocol: 'graphql',
          reason: 'custom_scalar_validation_unavailable',
        };
      if (input.direction === 'output')
        return {
          ...validateGraphqlResponse(
            g,
            schema,
            query,
            operation,
            coerced.variableValues,
            scalarProfiles.outputs,
            input.payload,
          ),
          protocol: 'graphql',
          validation: 'selected_response_and_declared_scalar_contracts',
        };
      return {
        available: true,
        valid: !coerced.errors,
        protocol: 'graphql',
        validation: 'query_and_variable_coercion',
      };
    }
    if (format === 'protobuf') {
      const p = (await import('protobufjs')).default;
      const { createProtobufMessage, encodeProtobufMessage, validProtobufMapKey } =
        await import('./protobuf-creator.mjs');
      const root = p.Root.fromJSON(native).resolveAll();
      const path =
        input.bytesBase64 !== undefined && typeof input.transportPath === 'string'
          ? '/grpc' + input.transportPath
          : input.native.operationPaths?.[0];
      if (typeof path !== 'string' || !path.startsWith('/grpc/'))
        return { available: false, valid: false };
      if (!input.native.operationPaths?.includes(path))
        return { available: true, valid: false, reason: 'grpc_operation_binding_mismatch' };
      const [, service, method] = path.slice('/grpc/'.length).match(/^(.*)\/([^/]+)$/) ?? [];
      const operation = root.lookupService(service).methods[method];
      operation.resolve();
      const response = input.direction === 'output';
      const type = response ? operation.resolvedResponseType : operation.resolvedRequestType;
      if (
        input.grpcStatusDetailsBase64 !== undefined &&
        (!response || input.bytesBase64 === undefined)
      )
        return { available: true, valid: false, reason: 'grpc_status_details_invalid' };
      if (input.bytesBase64 !== undefined) {
        if (typeof input.transportPath !== 'string')
          return { available: false, valid: false, reason: 'grpc_transport_binding_unavailable' };
        const status = response ? grpcStatusCode(input.grpcStatus) : '0';
        if (status === undefined)
          return { available: true, valid: false, reason: 'grpc_status_invalid' };
        const fault = response && status !== '0';
        if (input.grpcStatusDetailsBase64 !== undefined) {
          const details = grpcStatusDetailsBytes(input.grpcStatusDetailsBase64);
          if (!fault || details === undefined)
            return { available: true, valid: false, reason: 'grpc_status_details_invalid' };
          let detailsType;
          try {
            detailsType = root.lookupType('google.rpc.Status');
          } catch {
            return {
              available: false,
              valid: false,
              reason: 'grpc_status_details_type_unavailable',
            };
          }
          const code = detailsType.fieldsById[1],
            message = detailsType.fieldsById[2],
            entries = detailsType.fieldsById[3];
          if (
            detailsType.fieldsArray.length !== 3 ||
            code?.type !== 'int32' ||
            message?.type !== 'string' ||
            entries?.resolvedType?.fullName !== '.google.protobuf.Any' ||
            !entries.repeated ||
            entries.map ||
            [code, message].some(
              (field) => field.map || field.repeated || field.partOf || field.required,
            )
          )
            return {
              available: false,
              valid: false,
              reason: 'grpc_status_details_type_unavailable',
            };
          try {
            const { fields: state, mismatchedFields } = validateProtobufWire(
              details,
              detailsType,
              root,
            );
            if (mismatchedFields)
              return {
                available: false,
                valid: false,
                reason: 'grpc_status_details_type_mismatch',
              };
            if (state.has(1) && String(state.get(1).value) !== status)
              return { available: true, valid: false, reason: 'grpc_status_details_code_mismatch' };
          } catch (error) {
            if (['grpc_any_type_unavailable', 'grpc_wire_resource_limit'].includes(error.message))
              return { available: false, valid: false, reason: error.message };
            return { available: true, valid: false, reason: 'grpc_status_details_invalid' };
          }
        }
        if (
          typeof input.bytesBase64 !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            input.bytesBase64,
          )
        )
          return { available: false, valid: false };
        const frames = Buffer.from(input.bytesBase64, 'base64');
        if (frames.length > 1024 * 1024) return { available: true, valid: false };
        const encoding = input.grpcEncoding ?? 'identity';
        if (!['identity', 'gzip', 'deflate'].includes(encoding))
          return { available: false, valid: false, reason: 'grpc_encoding_unavailable' };
        let decodedBytes = 0;
        let unknownFields = 0,
          knownFieldWireMismatches = 0;
        let offset = 0,
          count = 0;
        while (offset < frames.length) {
          if (offset + 5 > frames.length || frames[offset] > 1)
            return {
              available: true,
              valid: false,
              reason: 'grpc_frame_invalid',
            };
          const compressed = frames[offset] === 1;
          const length = frames.readUInt32BE(offset + 1);
          offset += 5;
          if (offset + length > frames.length || ++count > 1000)
            return { available: true, valid: false };
          let messageBytes = frames.subarray(offset, offset + length);
          if (compressed) {
            if (encoding === 'identity')
              return { available: true, valid: false, reason: 'grpc_compression_header_missing' };
            try {
              messageBytes = (encoding === 'gzip' ? gunzipSync : inflateSync)(messageBytes, {
                maxOutputLength: 1024 * 1024 - decodedBytes,
              });
            } catch {
              return { available: true, valid: false, reason: 'grpc_compression_invalid_or_limit' };
            }
          }
          decodedBytes += messageBytes.length;
          if (decodedBytes > 1024 * 1024)
            return { available: true, valid: false, reason: 'grpc_decoded_byte_limit' };
          try {
            const result = validateProtobufWire(messageBytes, type, root);
            unknownFields += result.unknownFields;
            knownFieldWireMismatches += result.mismatchedFields;
          } catch (error) {
            if (error.message === 'grpc_wire_resource_limit')
              return { available: false, valid: false, reason: 'grpc_wire_resource_limit' };
            if (error.message === 'grpc_any_type_unavailable')
              return { available: false, valid: false, reason: error.message };
            return { available: true, valid: false, reason: 'grpc_wire_invalid' };
          }
          offset += length;
        }
        if (
          !(response ? operation.responseStream : operation.requestStream) &&
          (count > 1 || (!fault && count !== 1))
        )
          return { available: true, valid: false };
        return {
          available: true,
          valid: true,
          protocol: 'grpc',
          validation: 'framed_descriptor_wire_validation',
          messages: count,
          unknownFields,
          knownFieldWireMismatches,
          ...(input.grpcStatusDetailsBase64 !== undefined ? { grpcStatusDetails: true } : {}),
          ...(response ? { grpcStatus: status, ...(fault ? { fault: true } : {}) } : {}),
        };
      }
      const known = (value, message, depth = 0) => {
        if (depth > 32 || !value || typeof value !== 'object' || Array.isArray(value)) return false;
        return Object.entries(value).every(([key, entry]) => {
          const field = message.fields[key];
          if (!field) return false;
          const check = (value) => {
            if (field.resolvedType instanceof p.Type)
              return known(value, field.resolvedType, depth + 1);
            if (field.resolvedType instanceof p.Enum)
              return typeof value === 'string'
                ? Object.hasOwn(field.resolvedType.values, value)
                : Number.isInteger(value) &&
                    Object.values(field.resolvedType.values).includes(value);
            if (/64$/.test(field.type)) {
              if (
                !(typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value)) &&
                !Number.isSafeInteger(value)
              )
                return false;
              const unsigned = field.type.startsWith('u') || field.type === 'fixed64';
              return (
                BigInt(value) >= (unsigned ? 0n : -(1n << 63n)) &&
                BigInt(value) <= (unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n)
              );
            }
            if (/32$/.test(field.type)) {
              const unsigned = field.type.startsWith('u') || field.type === 'fixed32';
              return (
                Number.isInteger(value) &&
                value >= (unsigned ? 0 : -2147483648) &&
                value <= (unsigned ? 4294967295 : 2147483647)
              );
            }
            if (field.type === 'string') return typeof value === 'string';
            if (field.type === 'bool') return typeof value === 'boolean';
            if (field.type === 'float' || field.type === 'double')
              return (
                typeof value === 'number' &&
                Number.isFinite(value) &&
                (field.type !== 'float' || Number.isFinite(Math.fround(value)))
              );
            if (field.type === 'bytes')
              return (
                typeof value === 'string' &&
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
              );
            return false;
          };
          return field.map
            ? entry !== null &&
                typeof entry === 'object' &&
                !Array.isArray(entry) &&
                Object.keys(entry).every((key) => validProtobufMapKey(key, field.keyType)) &&
                Object.values(entry).every(check)
            : field.repeated
              ? Array.isArray(entry) && entry.every(check)
              : check(entry);
        });
      };
      if (!known(payload, type)) return { available: true, valid: false, protocol: 'grpc' };
      const message = createProtobufMessage(payload, type),
        error = type.verify(message);
      if (error) return { available: true, valid: false, protocol: 'grpc' };
      const encoded = encodeProtobufMessage(message, type);
      if (encoded.length > 1024 * 1024) return { available: false, valid: false };
      try {
        const result = validateProtobufWire(encoded, type, root);
        if (result.mismatchedFields)
          return {
            available: false,
            valid: false,
            reason: 'grpc_wire_type_mismatch',
            protocol: 'grpc',
          };
      } catch (error) {
        return {
          available: !['grpc_any_type_unavailable', 'grpc_wire_resource_limit'].includes(
            error.message,
          ),
          valid: false,
          reason: ['grpc_any_type_unavailable', 'grpc_wire_resource_limit'].includes(error.message)
            ? error.message
            : 'grpc_wire_invalid',
          protocol: 'grpc',
        };
      }
      return {
        available: true,
        valid: true,
        protocol: 'grpc',
        validation: 'descriptor_encode_wire_validation',
      };
    }
    if (format === 'asyncapi') {
      if (input.transport?.protocol === 'kafka')
        return validateKafkaPayload(input, validateAsyncapiPayload);
      return validateAsyncapiPayload(input);
    }
    return { available: false, valid: false, protocol: format ?? 'unknown' };
  } catch {
    return { available: false, valid: false, protocol: format ?? 'unknown' };
  }
}
