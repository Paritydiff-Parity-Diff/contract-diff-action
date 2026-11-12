import { classifyChange } from '../../packages/classify/src/classifier';
import { mapOasdiffChanges } from '../../packages/detect/src/changes';
import { rejectGeneratedInputMetadata } from '../../packages/detect/src/input-metadata';
import { snapshotNativeImports } from '../../packages/detect/src/native-imports';
import { normalizeSpec } from '../../packages/detect/src/normalize';
import { normalizeToOas3, type SourceFormat } from '../../packages/detect/src/normalize-format';
import { runOasdiffChangelog } from '../../packages/detect/src/oasdiff';
import { parseSpec, type SpecFormat } from '../../packages/detect/src/parse';
import { parseProtocolContract } from '../../packages/detect/src/protocol-parser';
import { snapshotReferences, type ReferencePolicy } from '../../packages/detect/src/references';
import { nativeFindings } from './native-findings';

const standards = ['openapi', 'graphql', 'grpc', 'asyncapi', 'soap'] as const;
type Standard = (typeof standards)[number];
export interface ContractInput {
  path: string;
  standard: Standard;
  graphqlOperations?: string[];
}
export type ReadContractFile = (path: string) => Promise<string | null>;
export const CONTRACT_FILE_LIMIT = 512 * 1024;
const referenceOrigin = 'https://contract-files.invalid';

export function validContractPath(path: string) {
  return (
    path.length <= 300 &&
    path.split('/').length <= 16 &&
    path
      .split('/')
      .every(
        (part) =>
          /^[\p{L}\p{N}_. -]{1,100}$/u.test(part) &&
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
      )
  );
}

export function parseContracts(raw: string): ContractInput[] {
  if (Buffer.byteLength(raw) > 8192) throw new Error('Contract configuration is too large');
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length < 1 || value.length > 8)
    throw new Error('Configure between one and eight contract files');
  const paths = new Set<string>();
  return value.map((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['path', 'standard', 'graphqlOperations'].includes(key))
    )
      throw new Error('Each contract needs a path and standard');
    const { path, standard, graphqlOperations } = input as Partial<ContractInput>;
    if (
      typeof path !== 'string' ||
      !validContractPath(path) ||
      !standard ||
      !standards.includes(standard) ||
      paths.has(path)
    )
      throw new Error('Invalid or duplicate contract path or standard');
    paths.add(path);
    if (
      graphqlOperations !== undefined &&
      (standard !== 'graphql' ||
        !Array.isArray(graphqlOperations) ||
        !graphqlOperations.length ||
        graphqlOperations.length > 12 ||
        new Set(graphqlOperations).size !== graphqlOperations.length ||
        graphqlOperations.some(
          (name) => typeof name !== 'string' || !validContractPath(name) || name === path,
        ))
    )
      throw new Error('GraphQL operation fixtures must be distinct repository files');
    return { path, standard, ...(graphqlOperations ? { graphqlOperations } : {}) };
  });
}

const formats = {
  graphql: 'graphql',
  grpc: 'protobuf',
  soap: 'xml',
} satisfies Partial<Record<Standard, SpecFormat>>;
const expected = {
  openapi: ['openapi', 'swagger2'],
  graphql: ['graphql'],
  grpc: ['protobuf'],
  asyncapi: ['asyncapi'],
  soap: ['wsdl'],
} satisfies Record<Standard, SourceFormat[]>;
const runtimeOnlyIssues = new Set([
  'GraphQL selection sets, error behavior and transport binding require repository/runtime evidence',
  'AsyncAPI broker bindings, headers, traits and runtime delivery semantics need native repository validation',
  'Protocol Buffer wire field numbers, defaults, oneofs and streaming require descriptor/runtime compatibility validation',
  'XML Schema and SOAP serialization are preserved as native evidence; full XSD runtime validation is required',
]);
const problem = (message: string) => Object.assign(new Error(message), { safeReason: message });

async function prepare(contract: ContractInput, raw: string, read: ReadContractFile) {
  const encoding =
    contract.standard in formats
      ? formats[contract.standard as keyof typeof formats]
      : contract.path.toLowerCase().endsWith('.json')
        ? 'json'
        : 'yaml';
  const parsed = parseSpec(raw, encoding, CONTRACT_FILE_LIMIT);
  if (!parsed.ok) throw problem('Contract syntax or size is invalid');
  const input = parsed.value;
  rejectGeneratedInputMetadata(input);
  const sourceUrl =
    referenceOrigin + '/' + contract.path.split('/').map(encodeURIComponent).join('/');
  const policy: ReferencePolicy = {
    sourceUrl,
    fetchOptions: { ssrf: { allowedHosts: [] }, byteCap: CONTRACT_FILE_LIMIT },
    maxDocuments: 24,
    maxDepth: 12,
    maxBytes: 4 * 1024 * 1024,
    timeoutMs: 30000,
    fetcher: {
      async fetch(target) {
        const url = new URL(target);
        if (
          url.origin === referenceOrigin &&
          !url.search &&
          !url.username &&
          !url.password &&
          !/%2f|%5c/i.test(url.pathname)
        ) {
          const path = decodeURIComponent(url.pathname.slice(1));
          if (validContractPath(path)) {
            const body = await read(path);
            if (body !== null) return { ok: true, value: { status: 'fetched', body } };
          }
        }
        return { ok: false, error: { kind: 'http', error: { kind: 'http_status', status: 404 } } };
      },
    },
  };
  let document = input;
  let incomplete = false;
  const runtimeNotes: string[] = [];
  let nativeFormat: SourceFormat | undefined;
  if (contract.standard === 'openapi' || contract.standard === 'asyncapi') {
    const snapshot = await snapshotReferences(input, policy);
    if (!snapshot.ok)
      throw problem('A contract reference could not be resolved within this revision');
    document = snapshot.value.document;
    incomplete = snapshot.value.issues.length > 0;
  } else {
    try {
      document = await snapshotNativeImports(input, policy);
    } catch {
      throw problem('A contract import could not be resolved within this revision');
    }
  }
  if (contract.standard !== 'openapi') {
    if (
      contract.standard === 'asyncapi' &&
      typeof (document as Record<string, unknown> | null)?.['asyncapi'] !== 'string'
    )
      throw problem('File does not match the configured contract standard');
    const protocol = await parseProtocolContract(document);
    document = protocol.document;
    nativeFormat = protocol.sourceFormat;
    const issues = protocol.document['x-paritydiff-coverage-issues'];
    if (Array.isArray(issues)) {
      const staticIssues = issues.filter((issue) => !runtimeOnlyIssues.has(issue));
      for (const issue of issues) if (runtimeOnlyIssues.has(issue)) runtimeNotes.push(issue);
      if (staticIssues.length) {
        protocol.document['x-paritydiff-coverage-issues'] = staticIssues;
        incomplete = true;
      } else {
        delete protocol.document['x-paritydiff-coverage-issues'];
      }
    }
  }
  const converted = normalizeToOas3(document);
  if (!converted.ok) throw problem('Contract validation failed');
  const sourceFormat = nativeFormat ?? converted.value.sourceFormat;
  if (!(expected[contract.standard] as SourceFormat[]).includes(sourceFormat))
    throw problem('File does not match the configured contract standard');
  return { ...normalizeSpec(converted.value.document), incomplete, runtimeNotes };
}

interface Finding {
  classification: 'breaking' | 'non_breaking' | 'ambiguous' | 'deprecation';
  path: string;
  method: string | null;
  rule: string;
}
export interface ContractReport extends ContractInput {
  state: 'compared' | 'added' | 'removed' | 'incomplete';
  reason?: string;
  counts: Record<Finding['classification'], number>;
  findings: Finding[];
  runtimeNotes?: string[];
}

export async function compareContract(
  contract: ContractInput,
  base: ReadContractFile,
  head: ReadContractFile,
  diff: typeof runOasdiffChangelog = runOasdiffChangelog,
): Promise<ContractReport> {
  const counts = { breaking: 0, non_breaking: 0, ambiguous: 0, deprecation: 0 };
  const report: ContractReport = { ...contract, state: 'compared', counts, findings: [] };
  const add = (finding: Finding) => {
    counts[finding.classification]++;
    if (finding.classification !== 'non_breaking' && report.findings.length < 25)
      report.findings.push(finding);
  };
  try {
    const rawBefore = await base(contract.path);
    const rawAfter = await head(contract.path);
    if (rawBefore === null && rawAfter === null)
      throw problem('Configured file is missing in both revisions');
    const before = rawBefore === null ? null : await prepare(contract, rawBefore, base);
    const after = rawAfter === null ? null : await prepare(contract, rawAfter, head);
    const notes = [...new Set([...(before?.runtimeNotes ?? []), ...(after?.runtimeNotes ?? [])])];
    if (notes.length) report.runtimeNotes = notes;
    if (!before) report.state = 'added';
    if (!after) {
      report.state = 'removed';
      add({
        classification: 'breaking',
        path: contract.path,
        method: null,
        rule: 'contract.removed',
      });
    }
    let nativeIncomplete = false;
    if (before && after && (before.hash !== after.hash || contract.graphqlOperations?.length)) {
      try {
        const native = await nativeFindings(
          contract.standard,
          contract.path,
          before.document,
          after.document,
          contract.graphqlOperations,
          base,
        );
        for (const finding of native) add(finding);
      } catch {
        nativeIncomplete = true;
      }
    }
    if (before && after && before.hash !== after.hash) {
      const changes = await diff(JSON.stringify(before.document), JSON.stringify(after.document));
      if (!changes.ok) throw problem('Contract comparison engine could not complete');
      for (const change of mapOasdiffChanges({
        vendorId: 'contract-diff',
        releaseId: 'pull-request',
        specHashFrom: before.hash,
        specHashTo: after.hash,
        evidenceStrength: 'version_bumped',
        changes: changes.value,
      })) {
        const result = classifyChange(change, {
          strictUnknownRequestFields: 'unknown',
          exhaustiveTypedSdk: false,
        });
        add({
          classification: result.classification,
          path: change.path,
          method: change.method,
          rule: result.rule_id,
        });
      }
    }
    if (before?.incomplete || after?.incomplete || nativeIncomplete || counts.ambiguous > 0) {
      report.state = 'incomplete';
      report.reason = 'Some contract behavior could not be classified';
    }
  } catch (cause) {
    report.state = 'incomplete';
    report.reason =
      (cause as { safeReason?: string } | null)?.safeReason ??
      'Contract could not be read or validated';
  }
  return report;
}
