import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export type SpecBodyKind = 'raw' | 'normalized';
export interface SpecMetadata {
  version: string | null;
  operations: { method: string; path: string; summary: string }[];
}
export function readSpecMetadata(body: string): SpecMetadata | undefined {
  try {
    const doc = JSON.parse(body) as {
      info?: { version?: unknown };
      paths?: Record<string, Record<string, { summary?: unknown }> | null>;
    };
    const operations: SpecMetadata['operations'] = [];
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const [method, operation] of Object.entries(methods ?? {})) {
        if (!/^(get|post|put|patch|delete|head|options|trace)$/.test(method)) continue;
        operations.push({
          method: method.toUpperCase(),
          path,
          summary: typeof operation?.summary === 'string' ? operation.summary : '',
        });
        if (operations.length === 4) break;
      }
      if (operations.length === 4) break;
    }
    return { version: typeof doc.info?.version === 'string' ? doc.info.version : null, operations };
  } catch {
    return undefined;
  }
}

// Content-addressed, append-only spec storage (spec section 9.1). Keyed by hash,
// so a re-put is idempotent. The filesystem backend is used locally and in tests;
// an S3-compatible backend implementing the same interface is wired at deployment.
export interface SpecStore {
  put(hash: string, kind: SpecBodyKind, body: string): Promise<void>;
  get(hash: string, kind: SpecBodyKind): Promise<string | undefined>;
  getMetadata?(hash: string): Promise<SpecMetadata | undefined>;
}

export class FsSpecStore implements SpecStore {
  constructor(private readonly root: string) {}

  private locate(hash: string, kind: SpecBodyKind): string {
    return join(this.root, kind, `${hash}.txt`);
  }

  async put(hash: string, kind: SpecBodyKind, body: string): Promise<void> {
    const path = this.locate(hash, kind);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    if (kind === 'normalized') {
      const metadata = readSpecMetadata(body);
      if (metadata) await this.saveMetadata(hash, metadata);
    }
  }

  private async saveMetadata(hash: string, metadata: SpecMetadata): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return;
    const path = join(this.root, 'metadata', hash + '.json');
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, JSON.stringify(metadata), { flag: 'wx' });
      await rename(temporary, path);
    } catch {
      // Metadata can be rebuilt from the immutable specification.
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async getMetadata(hash: string): Promise<SpecMetadata | undefined> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return undefined;
    try {
      const metadata = JSON.parse(
        await readFile(join(this.root, 'metadata', hash + '.json'), 'utf8'),
      ) as SpecMetadata;
      if (
        (metadata.version === null || typeof metadata.version === 'string') &&
        Array.isArray(metadata.operations) &&
        metadata.operations.length <= 4 &&
        metadata.operations.every(
          (operation) =>
            typeof operation.method === 'string' &&
            typeof operation.path === 'string' &&
            typeof operation.summary === 'string',
        )
      )
        return metadata;
    } catch {
      // Older captures do not have the derived metadata file yet.
    }
    const body = await this.get(hash, 'normalized');
    const metadata = body ? readSpecMetadata(body) : undefined;
    if (metadata) await this.saveMetadata(hash, metadata);
    return metadata;
  }

  async get(hash: string, kind: SpecBodyKind): Promise<string | undefined> {
    try {
      return await readFile(this.locate(hash, kind), 'utf8');
    } catch {
      return undefined;
    }
  }
}
