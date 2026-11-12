import { Worker } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { object, type ContractObject } from './contract-tree';
import { contractBudget } from './schema-validation';
import type { SourceFormat } from './normalize-format';
import {
  validateNativeXsd,
  validateXsd,
  xsdParserConfigured,
  type XsdInput,
} from './xsd-validation';

export interface ProtocolContract {
  document: ContractObject;
  sourceFormat: SourceFormat;
}
let active = 0;
const waiting: (() => void)[] = [];
async function acquire(deadline: number): Promise<() => void> {
  if (active >= 2) {
    if (waiting.length >= 8) throw new Error('contract parser capacity unavailable');
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(
        () => {
          const index = waiting.indexOf(grant);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error('contract parser deadline exceeded'));
        },
        Math.max(1, deadline - performance.now()),
      );
      waiting.push(grant);
    });
  } else active++;
  return () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
}
export function protocolKind(
  input: unknown,
):
  | 'graphql'
  | 'graphql-compatibility'
  | 'asyncapi'
  | 'protobuf'
  | 'xml'
  | 'document'
  | 'imports'
  | 'semantic'
  | 'payload'
  | 'vocabularies'
  | undefined {
  const doc = object(input);
  if (doc?.['x-paritydiff-graphql-compatibility']) return 'graphql-compatibility';
  if (doc?.['x-paritydiff-schema-vocabularies']) return 'vocabularies';
  if (doc?.['x-paritydiff-payload-validation']) return 'payload';
  if (doc?.['x-paritydiff-semantic-comparison']) return 'semantic';
  if (doc?.['x-paritydiff-import-scan']) return 'imports';
  if (doc?.['asyncapi']) return 'asyncapi';
  if (doc?.['sdl'] || doc?.['__schema'] || object(doc?.['data'])?.['__schema']) return 'graphql';
  if (doc?.['xml']) return 'xml';
  if (doc?.['proto']) return 'protobuf';
  if (doc?.['x-paritydiff-upload-kind'] === 'document') return 'document';
  return undefined;
}
export async function parseProtocolContract(
  input: unknown,
  timeoutMs?: number,
): Promise<ProtocolContract> {
  const kind = protocolKind(input);
  const deadline = performance.now() + (timeoutMs ?? (kind === 'document' ? 60000 : 10000));
  const budget = contractBudget(input);
  if (!kind || budget || Buffer.byteLength(JSON.stringify(input)) > 20 * 1024 * 1024)
    throw new Error(budget ?? 'unsupported or oversized protocol input');
  const release = await acquire(deadline);
  try {
    const nativeDocument = object(object(object(input)?.['native'])?.['document']);
    if (kind === 'payload' && nativeDocument?.['x-paritydiff-source-format'] === 'xsd')
      return {
        sourceFormat: 'document',
        document: {
          validation: await validateNativeXsd(
            nativeDocument,
            object(input)?.['payload'],
            Math.max(1, deadline - performance.now()),
          ),
        },
      };
    if (kind === 'document' && ['pdf', 'image'].includes(String(object(input)?.['format'])))
      return await new Promise<ProtocolContract>((resolve, reject) => {
        const child = fork(new URL('./protocol-parser.worker.mjs', import.meta.url), [], {
          env: {},
          execArgv: ['--max-old-space-size=256'],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let settled = false;
        const timer = setTimeout(
          () => finish(new Error('contract parser deadline exceeded')),
          Math.max(1, deadline - performance.now()),
        );
        const finish = (error?: Error, value?: ProtocolContract) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const done = () => (error ? reject(error) : resolve(value!));
          child.once('exit', done);
          if (!child.kill()) done();
        };
        child.stdout?.resume();
        child.stderr?.resume();
        child.once(
          'message',
          (result: { ok: boolean; value?: ProtocolContract; reason?: string }) => {
            if (!result.ok || !object(result.value?.document))
              finish(new Error(result.reason ?? 'OCR parser failed'));
            else finish(undefined, result.value);
          },
        );
        child.once('error', () => finish(new Error('OCR process unavailable')));
        child.once('exit', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error('OCR process exited before validation'));
          }
        });
        child.send({ kind, input });
      });
    const parsed = await new Promise<ProtocolContract>((resolve, reject) => {
      if (performance.now() >= deadline) {
        reject(new Error('contract parser deadline exceeded'));
        return;
      }
      const worker = new Worker(new URL('./protocol-parser.worker.mjs', import.meta.url), {
        workerData: {
          kind,
          input:
            kind === 'payload' && nativeDocument?.['x-paritydiff-source-format'] === 'wsdl'
              ? { ...object(input), soapBinding: true }
              : input,
        },
        env: {},
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 2,
        },
        stdout: true,
        stderr: true,
      });
      let settled = false;
      const finish = (error?: Error, value?: ProtocolContract) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate().finally(() => {
          if (error) reject(error);
          else resolve(value!);
        });
      };
      const timer = setTimeout(
        () => finish(new Error('contract parser deadline exceeded')),
        Math.max(1, deadline - performance.now()),
      );
      worker.stdout?.resume();
      worker.stderr?.resume();
      worker.once(
        'message',
        (result: { ok: boolean; value?: ProtocolContract; reason?: string }) => {
          if (!result.ok || !object(result.value?.document))
            finish(new Error(result.reason ?? 'parser returned invalid output'));
          else finish(undefined, result.value);
        },
      );
      worker.once('error', () => finish(new Error('contract parser unavailable')));
      worker.once('exit', () => {
        if (!settled) finish(new Error('contract parser exited before validation'));
      });
    });
    if (kind === 'payload' && nativeDocument?.['x-paritydiff-source-format'] === 'wsdl') {
      const binding = parsed.document['validation'] as {
        available: boolean;
        valid: boolean;
        checks?: {
          schemaFile: string;
          sources?: readonly string[];
          payload?: string;
          dialect?: '1.0' | '1.1';
          typeChecks?: readonly { typeName: string; payload?: string; actualTypeName?: string }[];
          soapEncoding?: XsdInput['soapEncoding'];
          graphReferences?: XsdInput['graphReferences'];
          applicationCodec?: {
            part: string;
            format: string;
            implementation: string;
            payloadHash: string;
          };
        }[];
        files?: Record<string, string>;
        fault?: boolean;
        encoded?: boolean;
        bindingId?: string;
        protocol?: string;
        packaging?: string;
        attachments?: number;
      };
      if (binding.available && binding.valid && binding.checks?.length && binding.files) {
        const checks: NonNullable<typeof binding.checks> = [];
        for (const check of binding.checks) {
          const group =
            check.payload === undefined &&
            check.typeChecks?.length &&
            !check.soapEncoding &&
            !check.graphReferences
              ? checks.find(
                  (prior) =>
                    !prior.soapEncoding &&
                    !prior.graphReferences &&
                    prior.schemaFile === check.schemaFile &&
                    (prior.dialect ?? '1.0') === (check.dialect ?? '1.0') &&
                    JSON.stringify(prior.sources) === JSON.stringify(check.sources) &&
                    (prior.typeChecks?.length ?? 0) + check.typeChecks!.length <= 1000,
                )
              : undefined;
          if (group) group.typeChecks = [...(group.typeChecks ?? []), ...check.typeChecks!];
          else checks.push({ ...check });
        }
        let validation: Awaited<ReturnType<typeof validateXsd>> | undefined;
        for (const check of checks) {
          const documents = Object.fromEntries(
            Object.entries(binding.files).filter(
              ([file]) =>
                file !== check.schemaFile && (!check.sources || check.sources.includes(file)),
            ),
          );
          validation = await validateXsd(
            {
              schema: binding.files[check.schemaFile]!,
              documents,
              dialect: check.dialect ?? '1.0',
              ...(check.payload !== undefined ? { payload: check.payload } : {}),
              rootFile: check.schemaFile,
              ...(check.typeChecks ? { typeChecks: check.typeChecks } : {}),
              ...(check.soapEncoding ? { soapEncoding: check.soapEncoding } : {}),
              ...(check.graphReferences ? { graphReferences: check.graphReferences } : {}),
            },
            Math.max(1, deadline - performance.now()),
          );
          if (!validation.available || !validation.valid) break;
        }
        parsed.document['validation'] = {
          ...validation,
          ...(binding.checks.some((check) => check.applicationCodec)
            ? {
                applicationCodecs: binding.checks.flatMap((check) =>
                  check.applicationCodec ? [check.applicationCodec] : [],
                ),
              }
            : {}),
          protocol: binding.protocol ?? 'soap',
          ...(binding.packaging
            ? { packaging: binding.packaging, attachments: binding.attachments }
            : {}),
          ...(binding.bindingId ? { bindingId: binding.bindingId } : {}),
          validation:
            binding.protocol === 'wsdl-http'
              ? 'wsdl_http_binding_and_xsd'
              : binding.packaging === 'xop' || binding.packaging === 'soap-mime'
                ? 'wsdl_' + binding.packaging.replace('-', '_') + '_binding_and_xsd'
                : binding.encoded
                  ? 'wsdl_encoded_graph_and_xsd'
                  : 'wsdl_body_binding_and_xsd',
          ...(binding.encoded ? { encoded: true } : {}),
          ...(binding.fault ? { fault: true } : {}),
        };
      } else {
        const { available, valid, fault, bindingId } = binding;
        parsed.document['validation'] = {
          available,
          valid,
          protocol: binding.protocol ?? 'soap',
          ...(binding.packaging
            ? { packaging: binding.packaging, attachments: binding.attachments }
            : {}),
          ...(bindingId ? { bindingId } : {}),
          ...(fault ? { fault: true } : {}),
          reason:
            parsed.document['validation'] &&
            (parsed.document['validation'] as Record<string, unknown>)['reason'],
        };
      }
    }
    if (kind === 'xml' && parsed.sourceFormat === 'xsd') {
      const validation = await validateNativeXsd(
        parsed.document,
        undefined,
        Math.max(1, deadline - performance.now()),
      );
      parsed.document['x-paritydiff-native-schema-validation'] = validation;
      if (xsdParserConfigured() && !validation.valid)
        throw new Error('XSD contract schema validation unavailable or failed');
    }
    if (kind === 'xml' && parsed.sourceFormat === 'wsdl') {
      const bundle = parsed.document['x-paritydiff-xml-schema-bundle'] as {
        schemas: {
          file: string;
          dialect?: '1.0' | '1.1';
          member?: boolean;
          generated?: boolean;
          sources?: readonly string[];
        }[];
        files: Record<string, string>;
      };
      const validations = [];
      for (const schema of bundle.schemas.filter((schema) => !schema.member && !schema.generated)) {
        const documents = Object.fromEntries(
          Object.entries(bundle.files).filter(
            ([file]) => file !== schema.file && (!schema.sources || schema.sources.includes(file)),
          ),
        );
        const validation = await validateXsd(
          {
            schema: bundle.files[schema.file]!,
            documents,
            rootFile: schema.file,
            dialect:
              schema.dialect ?? (parsed.document['x-paritydiff-xsd-dialect'] as '1.0' | '1.1'),
          },
          Math.max(1, deadline - performance.now()),
        );
        validations.push({ file: schema.file, ...validation });
        if (xsdParserConfigured() && !validation.valid)
          throw new Error('WSDL embedded XSD validation unavailable or failed');
      }
      parsed.document['x-paritydiff-native-schema-validation'] = validations;
    }
    return parsed;
  } finally {
    release();
  }
}
