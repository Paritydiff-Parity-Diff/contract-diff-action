import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configureXsdParser } from '../../packages/detect/src/xsd-validation';
import { reportMarkdown, runAction } from './action';
import { compareContract, parseContracts, type ContractInput } from './compare';
import { commentMarker, GitHubContracts, type PullRequest } from './github';

const file = (source: string) => async () => source;
configureXsdParser(process.env.XSD_PYTHON_BIN ?? '');
const response = { '200': { description: 'ok' } };
const openapi = (remove: boolean) =>
  JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Fixture', version: '1' },
    paths: {
      '/keep': { get: { responses: response } },
      ...(!remove ? { '/old': { get: { responses: response } } } : {}),
    },
  });
const graphql = (remove: boolean) =>
  'type Query { keep: String ' + (remove ? '' : 'old: String') + ' }';
const grpc = (remove: boolean) =>
  'syntax="proto3"; message Input {string name=1;} message Output {string value=1;} ' +
  'service Fixture {rpc Keep(Input) returns(Output); ' +
  (remove ? '' : 'rpc Old(Input) returns(Output);') +
  '}';
const asyncapi = (remove: boolean) => {
  const send = { action: 'send', channel: { $ref: '#/channels/events' } };
  return JSON.stringify({
    asyncapi: '3.0.0',
    info: { title: 'Fixture', version: '1' },
    channels: {
      events: { address: 'events', messages: { notice: { payload: { type: 'string' } } } },
    },
    operations: { keep: send, ...(!remove ? { old: send } : {}) },
  });
};
const soap = (remove: boolean) => {
  const names = remove ? ['Keep'] : ['Keep', 'Old'];
  const operations = names.map(
    (name) =>
      '<operation name="' +
      name +
      '"><input message="t:Request"/><output message="t:Reply"/></operation>',
  );
  const bindings = names.map(
    (name) =>
      '<operation name="' +
      name +
      '"><s:operation soapAction="urn:' +
      name +
      '"/><input><s:body use="literal"/></input><output><s:body use="literal"/></output></operation>',
  );
  return (
    '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:s="http://schemas.xmlsoap.org/wsdl/soap/" ' +
    'xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:fixture" targetNamespace="urn:fixture">' +
    '<types><xs:schema targetNamespace="urn:fixture"><xs:element name="In" type="xs:string"/>' +
    '<xs:element name="Out" type="xs:string"/></xs:schema></types>' +
    '<message name="Request"><part name="body" element="t:In"/></message>' +
    '<message name="Reply"><part name="body" element="t:Out"/></message>' +
    '<portType name="Fixture">' +
    operations.join('') +
    '</portType>' +
    '<binding name="FixtureSoap" type="t:Fixture"><s:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>' +
    bindings.join('') +
    '</binding><service name="FixtureService"><port name="Soap" binding="t:FixtureSoap">' +
    '<s:address location="https://example.invalid/soap"/></port></service></definitions>'
  );
};
const fixtures = [
  { path: 'contract.json', standard: 'openapi', source: openapi },
  { path: 'schema.graphql', standard: 'graphql', source: graphql },
  { path: 'service.proto', standard: 'grpc', source: grpc },
  { path: 'asyncapi.json', standard: 'asyncapi', source: asyncapi },
  { path: 'service.wsdl', standard: 'soap', source: soap },
] as const;

describe('five supported contract standards', () => {
  it.each(fixtures)(
    'normalizes changed $standard contracts with the production parser',
    async ({ path, standard, source }) => {
      const diff = vi.fn<NonNullable<Parameters<typeof compareContract>[3]>>(async () => ({
        ok: true,
        value: [
          { id: 'api-path-removed', path: '/old', operation: 'GET', level: 3, text: 'removed' },
        ],
      }));
      const result = await compareContract(
        { path, standard },
        file(source(false)),
        file(source(true)),
        diff,
      );
      expect(diff).toHaveBeenCalledOnce();
      expect(result.state, JSON.stringify(result)).toBe('compared');
      expect(result.counts.breaking).toBeGreaterThan(0);
    },
    30000,
  );

  it.skipIf(process.env.RUN_CONTRACT_DIFF_DOCKER !== '1').each(fixtures)(
    'detects actual $standard operation removal through the pinned comparison container',
    async ({ path, standard, source }) => {
      const result = await compareContract(
        { path, standard },
        file(source(false)),
        file(source(true)),
      );
      expect(result.counts.breaking, JSON.stringify(result)).toBeGreaterThan(0);
    },
    150000,
  );
});

it('diffs a same-revision GraphQL import and refuses external or missing references', async () => {
  const contract: ContractInput = { path: 'schema/api.graphql', standard: 'graphql' };
  const source = '#import "types.graphql"\ntype Query { item: Item }';
  const revision = (type: string) => async (path: string) =>
    path === contract.path ? source : path === 'schema/types.graphql' ? type : null;
  const diff = vi.fn<NonNullable<Parameters<typeof compareContract>[3]>>(async () => ({
    ok: true,
    value: [],
  }));
  const result = await compareContract(
    contract,
    revision('type Item { id: ID! name: String }'),
    revision('type Item { id: ID! }'),
    diff,
  );
  expect(result.state).toBe('compared');
  expect(diff).toHaveBeenCalledOnce();
  const unexpected = vi.fn(async (path: string) =>
    path === contract.path
      ? source.replace('types.graphql', 'https://example.invalid/types.graphql')
      : null,
  );
  expect(
    (await compareContract(contract, revision('type Item { id: ID! }'), unexpected)).state,
  ).toBe('incomplete');
  expect(unexpected.mock.calls).toEqual([[contract.path]]);
  expect(() => parseContracts('[{"path":"../private","standard":"openapi"}]')).toThrow();
});

it('checks native GraphQL union membership, gRPC wire numbers and streaming, and SOAP actions', async () => {
  const compare = (
    standard: ContractInput['standard'],
    path: string,
    before: string,
    after: string,
  ) =>
    compareContract({ path, standard }, file(before), file(after), async () => ({
      ok: true,
      value: [],
    }));
  const originalGraphql =
    'type Old { id: ID! } type Keep { id: ID! } union Result = Old | Keep type Query { item: Result }';
  const graph = await compare(
    'graphql',
    'schema.graphql',
    originalGraphql,
    originalGraphql.replace('Old | ', ''),
  );
  expect(graph.findings).toContainEqual(
    expect.objectContaining({
      classification: 'breaking',
      rule: 'graphql.type_removed_from_union',
    }),
  );
  const originalGrpc = grpc(true);
  const wire = await compare(
    'grpc',
    'service.proto',
    originalGrpc,
    originalGrpc.replace('name=1', 'name=2').replace('Keep(Input)', 'Keep(stream Input)'),
  );
  expect(wire.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        classification: 'breaking',
        rule: 'protobuf.field_number_changed',
      }),
      expect.objectContaining({
        classification: 'breaking',
        rule: 'protobuf.rpc_streaming_changed',
      }),
    ]),
  );
  const wsdl = await compare(
    'soap',
    'service.wsdl',
    soap(true),
    soap(true).replace('soapAction="urn:Keep"', 'soapAction="urn:Changed"'),
  );
  expect(wsdl.findings).toContainEqual(
    expect.objectContaining({ classification: 'breaking', rule: 'soap.action_changed' }),
  );
  expect(wsdl.runtimeNotes?.some((note) => note.includes('full XSD runtime validation'))).toBe(
    true,
  );
}, 60000);

it('validates base GraphQL operations against both schemas without reading replacements from the head', async () => {
  const contract = parseContracts(
    JSON.stringify([
      {
        path: 'api.graphql',
        standard: 'graphql',
        graphqlOperations: ['client/old.graphql', 'client/missing.graphql'],
      },
    ]),
  )[0]!;
  const base = async (path: string) =>
    path === contract.path
      ? graphql(false)
      : path.endsWith('old.graphql')
        ? 'query Existing { old }'
        : null;
  const head = vi.fn(async (path: string) =>
    path === contract.path ? graphql(true) : 'query Replacement { keep }',
  );
  const result = await compareContract(contract, base, head, async () => ({ ok: true, value: [] }));
  expect(head.mock.calls).toEqual([[contract.path]]);
  expect(result.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        classification: 'breaking',
        path: 'client/old.graphql',
        rule: 'graphql.operation_no_longer_valid',
      }),
      expect.objectContaining({
        classification: 'ambiguous',
        path: 'client/missing.graphql',
        rule: 'graphql.baseline_operation_invalid',
      }),
    ]),
  );
  expect(result.state).toBe('incomplete');
}, 30000);

const token = 'ghs_' + 'a'.repeat(36);
const base = 'b'.repeat(40);
const head = 'c'.repeat(40);
const tree = 'd'.repeat(40);
const newHead = 'e'.repeat(40);
const pull: PullRequest = {
  number: 17,
  base: { repository: 'fixture/repo', sha: base },
  head: { repository: 'fixture/fork', sha: head },
};
const pullResponse = (sha = head) =>
  Response.json({
    number: pull.number,
    state: 'open',
    base: { repo: { full_name: pull.base.repository }, sha: base },
    head: { repo: { full_name: pull.head.repository }, sha },
  });
const existing = (body: string, login = 'github-actions[bot]') => ({
  id: 19,
  body,
  user: { login, type: login === 'github-actions[bot]' ? 'Bot' : 'User' },
});

it('updates only the Actions bot comment and suppresses stale results', async () => {
  const markdown = commentMarker + '\nnew report';
  let sha = head;
  let old = commentMarker + '\nold report';
  const writes: { method: string; path: string; body: string }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.github.com');
    expect(options?.redirect).toBe('error');
    if (url.pathname.endsWith('/pulls/17')) return pullResponse(sha);
    if (options?.method === 'GET')
      return Response.json([existing(markdown, 'fixture-user'), existing(old)]);
    writes.push({
      method: options!.method!,
      path: url.pathname,
      body: JSON.parse(String(options?.body)).body,
    });
    return Response.json({ id: 19 });
  });
  const api = new GitHubContracts(token, fetcher);
  expect(await api.publish(pull.base.repository, pull, markdown)).toBe('updated');
  expect(writes).toEqual([
    { method: 'PATCH', path: '/repos/fixture/repo/issues/comments/19', body: markdown },
  ]);
  old = markdown;
  expect(await api.publish(pull.base.repository, pull, markdown)).toBe('unchanged');
  sha = newHead;
  expect(await api.publish(pull.base.repository, pull, markdown)).toBe('stale');
  expect(writes).toHaveLength(1);
});

it('reads immutable Git objects and posts a PR report on contract removal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paritydiff-action-test-'));
  const source = Buffer.from(openapi(false));
  const blob = createHash('sha1')
    .update('blob ' + source.length + '\0')
    .update(source)
    .digest('hex');
  const writes: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.github.com');
    const path = url.pathname;
    if (path.endsWith('/pulls/17')) return pullResponse();
    if (path.endsWith('/commits/' + base)) return Response.json({ sha: base, tree: { sha: tree } });
    if (path.endsWith('/commits/' + head)) return Response.json({ sha: head, tree: { sha: head } });
    if (path.endsWith('/trees/' + tree))
      return Response.json({
        sha: tree,
        truncated: false,
        tree: [{ path: 'contract.json', mode: '100644', type: 'blob', sha: blob }],
      });
    if (path.endsWith('/trees/' + head))
      return Response.json({ sha: head, truncated: false, tree: [] });
    if (path.endsWith('/blobs/' + blob))
      return Response.json({
        sha: blob,
        encoding: 'base64',
        size: source.length,
        content: source.toString('base64'),
      });
    if (path.endsWith('/issues/17/comments') && options?.method === 'GET') return Response.json([]);
    if (path.endsWith('/issues/17/comments') && options?.method === 'POST') {
      writes.push(JSON.parse(String(options.body)).body);
      return Response.json({ id: 9 }, { status: 201 });
    }
    throw new Error('Unexpected test request');
  });
  try {
    const event = join(dir, 'event.json');
    const summary = join(dir, 'summary.md');
    await writeFile(
      event,
      JSON.stringify({ number: 17, pull_request: { head: { sha: head }, base: { sha: base } } }),
    );
    const result = await runAction(
      {
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_EVENT_PATH: event,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: pull.base.repository,
        CONTRACT_DIFF_TOKEN: token,
        CONTRACT_DIFF_GATE: 'true',
        CONTRACT_DIFF_FILES: JSON.stringify([{ path: 'contract.json', standard: 'openapi' }]),
      },
      fetcher,
    );
    expect(result).toEqual({ status: 'created', breaking: 1, incomplete: 0, exitCode: 1 });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('contract.removed');
    expect(await readFile(summary, 'utf8')).toBe(writes[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('escapes contributor-controlled contract names and operation paths in Markdown', () => {
  const result = reportMarkdown(base, head, [
    {
      path: 'contract.json',
      standard: 'openapi',
      state: 'compared',
      counts: { breaking: 1, non_breaking: 0, ambiguous: 0, deprecation: 0 },
      findings: [
        {
          classification: 'breaking',
          method: null,
          path: '/x\n@team <img src=x>',
          rule: 'test.rule',
        },
      ],
    },
  ]);
  expect(result).toContain('&#64;team &lt;img src=x&gt;');
  expect(result).not.toContain('@team');
});
