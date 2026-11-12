import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseXml11, xml11SchemaSource, xmlVersion, type Xml11Tree } from './xml11.mjs';

export interface XsdValidation {
  available: boolean;
  valid: boolean;
  reason: string;
  dialect?: '1.0' | '1.1';
  xmlVersion?: '1.1';
  xmlSchemaVersion?: '1.1';
  xmlParser?: string;
}
export interface XsdInput {
  schema: string;
  documents?: Readonly<Record<string, string>>;
  dialect: '1.0' | '1.1';
  payload?: string;
  rootFile?: string;
  soapEncoding?:
    'http://schemas.xmlsoap.org/soap/encoding/' | 'http://www.w3.org/2003/05/soap-encoding';
  typeChecks?: readonly { typeName: string; payload?: string; actualTypeName?: string }[];
  graphReferences?: Readonly<Record<string, string>>;
}
let configuredPython = '';
export function configureXsdParser(python: string): void {
  if (python && (!isAbsolute(python) || python.length > 2000 || python.includes('\0')))
    throw new Error('invalid_xsd_runtime_config');
  configuredPython = python;
}
export function xsdParserConfigured(): boolean {
  return Boolean(configuredPython);
}
export async function validateNativeXsd(
  document: Record<string, unknown>,
  payload?: unknown,
  timeoutMs = 5000,
): Promise<XsdValidation> {
  const sources = document['x-paritydiff-native-xml-source'] as Record<string, string> | undefined;
  const root = String(document['x-paritydiff-native-root'] ?? 'root');
  const dialect = document['x-paritydiff-xsd-dialect'];
  if (
    document['x-paritydiff-source-format'] !== 'xsd' ||
    !sources?.[root] ||
    !['1.0', '1.1'].includes(String(dialect)) ||
    (payload !== undefined && typeof payload !== 'string')
  )
    return { available: false, valid: false, reason: 'native_xsd_context_unavailable' };
  const documents = Object.fromEntries(
    Object.entries(sources)
      .filter(([id]) => id !== root)
      .map(([id, source]) => [id + '.xsd', source]),
  );
  return validateXsd(
    {
      schema: sources[root],
      documents,
      dialect: dialect as '1.0' | '1.1',
      ...(payload !== undefined ? { payload: payload as string } : {}),
    },
    timeoutMs,
  );
}
let active = 0;
export async function validateXsd(
  input: XsdInput,
  timeoutMs = 5000,
  python = configuredPython,
): Promise<XsdValidation> {
  const unavailable = (reason: string): XsdValidation => ({
    available: false,
    valid: false,
    reason,
  });
  if (!python || !isAbsolute(python)) return unavailable('xsd_runtime_not_configured');
  if (active >= 2) return unavailable('xsd_parser_capacity_unavailable');
  if (
    !input ||
    !['1.0', '1.1'].includes(input.dialect) ||
    typeof input.schema !== 'string' ||
    (input.graphReferences !== undefined &&
      (!input.soapEncoding ||
        !input.graphReferences ||
        typeof input.graphReferences !== 'object' ||
        Array.isArray(input.graphReferences) ||
        Object.keys(input.graphReferences).length > 1000 ||
        Object.entries(input.graphReferences).some(
          ([id, payload]) =>
            !/^g[0-9]{1,4}$/.test(id) ||
            typeof payload !== 'string' ||
            Buffer.byteLength(payload) > 1024 * 1024,
        ))) ||
    (input.soapEncoding !== undefined &&
      ![
        'http://schemas.xmlsoap.org/soap/encoding/',
        'http://www.w3.org/2003/05/soap-encoding',
      ].includes(input.soapEncoding)) ||
    (input.typeChecks !== undefined &&
      (!Array.isArray(input.typeChecks) ||
        input.typeChecks.length > 1000 ||
        input.typeChecks.some(
          (check) =>
            !check ||
            typeof check.typeName !== 'string' ||
            check.typeName.length > 1000 ||
            !/^\{[^{}]*\}[^{}]+$/.test(check.typeName) ||
            (check.payload !== undefined &&
              (typeof check.payload !== 'string' ||
                Buffer.byteLength(check.payload) > 1024 * 1024)) ||
            (check.actualTypeName !== undefined &&
              (typeof check.actualTypeName !== 'string' ||
                check.actualTypeName.length > 1000 ||
                !/^\{[^{}]*\}[^{}]+$/.test(check.actualTypeName))),
        ))) ||
    (input.payload !== undefined && typeof input.payload !== 'string') ||
    Buffer.byteLength(JSON.stringify(input)) > 20 * 1024 * 1024
  )
    return unavailable('xsd_input_invalid');
  const rootFile = input.rootFile ?? 'root.xsd';
  const documents = { [rootFile]: input.schema, ...input.documents };
  if (input.documents && Object.hasOwn(input.documents, rootFile))
    return unavailable('xsd_bundle_root_collision');
  if (
    Object.keys(documents).length > 64 ||
    Object.entries(documents).some(
      ([path, body]) =>
        typeof body !== 'string' ||
        !path ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.includes(':') ||
        path.split('/').some((part) => !part || part === '.' || part === '..'),
    )
  )
    return unavailable('xsd_bundle_invalid');
  const deadline = performance.now() + Math.min(Math.max(timeoutMs, 1), 10000);
  active++;
  let dir: string | undefined;
  try {
    const xml11Infosets: Record<string, Xml11Tree> = {};
    const stagedDocuments: Record<string, string> = {};
    let xml11Schema = false;
    try {
      for (const [path, body] of Object.entries(documents)) {
        if (performance.now() >= deadline) return unavailable('xsd_deadline_exceeded');
        if (xmlVersion(body) === '1.1') {
          stagedDocuments[path] = xml11SchemaSource(body);
          xml11Schema = true;
        } else stagedDocuments[path] = body;
      }
      for (const payload of [
        input.payload,
        ...(input.typeChecks?.map((check) => check.payload) ?? []),
        ...Object.values(input.graphReferences ?? {}),
      ]) {
        if (payload === undefined || xmlVersion(payload) !== '1.1') continue;
        if (performance.now() >= deadline) return unavailable('xsd_deadline_exceeded');
        const hash = createHash('sha256').update(payload).digest('hex');
        xml11Infosets[hash] ??= parseXml11(payload).tree;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'xml11_invalid';
      return {
        available: ![
          'xml11_resource_limit',
          'xml_wire_version_unavailable',
          'xml11_schema_infoset_unavailable',
        ].includes(reason),
        valid: false,
        reason,
      };
    }
    dir = await mkdtemp(join(tmpdir(), 'paritydiff-xsd-'));
    const files: string[] = [];
    for (const [path, body] of Object.entries(stagedDocuments)) {
      if (performance.now() >= deadline) return unavailable('xsd_deadline_exceeded');
      const destination = join(dir, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, body, { mode: 0o400 });
      files.push(destination);
    }
    const result = await new Promise<XsdValidation>((resolve) => {
      const child = spawn(
        python,
        ['-I', fileURLToPath(new URL('../python/validate_xsd.py', import.meta.url))],
        { env: {}, cwd: dir!, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      const chunks: Buffer[] = [];
      let bytes = 0,
        failedReason = '';
      const timer = setTimeout(
        () => {
          failedReason = 'xsd_deadline_exceeded';
          child.kill('SIGKILL');
        },
        Math.max(1, deadline - performance.now()),
      );
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) {
          failedReason = 'xsd_output_limit';
          child.kill('SIGKILL');
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.once('error', () => {
        clearTimeout(timer);
        resolve(unavailable('xsd_runtime_unavailable'));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (failedReason || code !== 0) {
          resolve(unavailable(failedReason || 'xsd_parser_failed'));
          return;
        }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as XsdValidation;
          if (
            typeof value.available !== 'boolean' ||
            typeof value.valid !== 'boolean' ||
            typeof value.reason !== 'string' ||
            value.reason.length > 100
          )
            throw new Error('invalid');
          resolve(value);
        } catch {
          resolve(unavailable('xsd_result_invalid'));
        }
      });
      child.stdin.end(
        JSON.stringify({
          directory: dir,
          files,
          schema: join(dir!, rootFile),
          dialect: input.dialect,
          ...(input.payload !== undefined ? { payload: input.payload } : {}),
          ...(input.typeChecks !== undefined ? { typeChecks: input.typeChecks } : {}),
          ...(input.soapEncoding !== undefined ? { soapEncoding: input.soapEncoding } : {}),
          ...(input.graphReferences !== undefined
            ? { graphReferences: input.graphReferences }
            : {}),
          xml11Infosets,
        }),
      );
    });
    return xml11Schema || Object.keys(xml11Infosets).length
      ? {
          ...result,
          ...(Object.keys(xml11Infosets).length ? { xmlVersion: '1.1' as const } : {}),
          ...(xml11Schema ? { xmlSchemaVersion: '1.1' as const } : {}),
          xmlParser: 'saxes@6.0.0+xmlchars@2.2.0',
        }
      : result;
  } catch {
    return unavailable('xsd_staging_unavailable');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
    active--;
  }
}
