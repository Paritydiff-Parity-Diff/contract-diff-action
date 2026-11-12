import { createHash } from 'node:crypto';
import { CONTRACT_FILE_LIMIT, validContractPath, type ReadContractFile } from './compare';

const apiOrigin = 'https://api.github.com';
const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_DATA_REQUESTS = 280;
const MAX_CONTROL_REQUESTS = 20;
const MAX_RESPONSE = 3 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const commentMarker = '<!-- paritydiff-contract-diff:v1 -->';

interface Revision {
  repository: string;
  sha: string;
}
export interface PullRequest {
  number: number;
  base: Revision;
  head: Revision;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body || !response.headers.get('content-type')?.includes('application/json'))
    throw new Error('GitHub returned invalid data');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE) throw new Error('GitHub response exceeded the size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)),
  );
}

export function isRepository(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    repositoryPattern.test(value) &&
    value.split('/').every((part) => part !== '.' && part !== '..')
  );
}

export function sameRevision(a: PullRequest, b: PullRequest) {
  return (
    a.number === b.number &&
    a.base.sha === b.base.sha &&
    a.head.sha === b.head.sha &&
    a.base.repository.toLowerCase() === b.base.repository.toLowerCase() &&
    a.head.repository.toLowerCase() === b.head.repository.toLowerCase()
  );
}

export class GitHubContracts {
  private dataRequests = 0;
  private controlRequests = 0;
  private bytes = 0;

  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (token.length < 20 || token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token))
      throw new Error('A GitHub Actions token is required');
  }

  private async json(path: string, method = 'GET', body?: object, data = false) {
    if (
      data ? ++this.dataRequests > MAX_DATA_REQUESTS : ++this.controlRequests > MAX_CONTROL_REQUESTS
    )
      throw new Error('GitHub request budget exceeded');
    const url = new URL(path, apiOrigin);
    if (url.origin !== apiOrigin || !url.pathname.startsWith('/repos/'))
      throw new Error('Invalid GitHub API path');
    const response = await this.fetcher(url, {
      method,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + this.token,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok || (response.url && response.url !== url.href)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('GitHub API request failed (' + response.status + ')');
    }
    return boundedJson(response);
  }

  async pull(repository: string, number: number): Promise<PullRequest> {
    if (!isRepository(repository) || !Number.isSafeInteger(number) || number <= 0)
      throw new Error('Invalid pull request identity');
    const result = (await this.json('/repos/' + repository + '/pulls/' + number)) as {
      number?: number;
      state?: string;
      base?: { sha?: string; repo?: { full_name?: string } };
      head?: { sha?: string; repo?: { full_name?: string } };
    } | null;
    const base = result?.base?.repo?.full_name;
    const head = result?.head?.repo?.full_name;
    const baseSha = result?.base?.sha;
    const headSha = result?.head?.sha;
    if (
      result?.state !== 'open' ||
      result.number !== number ||
      !isRepository(base) ||
      base.toLowerCase() !== repository.toLowerCase() ||
      !isRepository(head) ||
      !baseSha ||
      !headSha ||
      !shaPattern.test(baseSha) ||
      !shaPattern.test(headSha)
    )
      throw new Error('Pull request revisions are unavailable');
    return {
      number,
      base: { repository: base, sha: baseSha },
      head: { repository: head, sha: headSha },
    };
  }

  reader(revision: Revision): ReadContractFile {
    if (!isRepository(revision.repository) || !shaPattern.test(revision.sha))
      throw new Error('Invalid Git revision');
    const prefix = '/repos/' + revision.repository + '/git/';
    type Entry = { path: string; mode: string; type: string; sha: string };
    let root: Promise<string> | undefined;
    const trees = new Map<string, Promise<Entry[]>>();
    const blobs = new Map<string, Promise<string>>();

    const read = (path: string) => this.json(prefix + path, 'GET', undefined, true);
    const rootTree = async () => {
      const data = (await read('commits/' + revision.sha)) as {
        sha?: string;
        tree?: { sha?: string };
      } | null;
      if (data?.sha !== revision.sha || !data.tree?.sha || !shaPattern.test(data.tree.sha))
        throw new Error('Invalid Git commit response');
      return data.tree.sha;
    };
    const tree = async (sha: string) => {
      const data = (await read('trees/' + sha)) as {
        sha?: string;
        tree?: Entry[];
        truncated?: boolean;
      } | null;
      if (data?.sha !== sha || data.truncated !== false || !Array.isArray(data.tree))
        throw new Error('Git tree is incomplete');
      return data.tree;
    };
    const blob = async (sha: string) => {
      const data = (await read('blobs/' + sha)) as {
        sha?: string;
        encoding?: string;
        size?: number;
        content?: string;
      } | null;
      if (
        data?.sha !== sha ||
        data.encoding !== 'base64' ||
        !Number.isSafeInteger(data.size) ||
        data.size! < 0 ||
        data.size! > CONTRACT_FILE_LIMIT ||
        typeof data.content !== 'string'
      )
        throw new Error('Contract blob is unavailable or oversized');
      const encoded = data.content.replace(/[\r\n]/g, '');
      const bytes = Buffer.from(encoded, 'base64');
      if (
        bytes.length !== data.size ||
        bytes.toString('base64') !== encoded ||
        createHash('sha1')
          .update('blob ' + bytes.length + '\0')
          .update(bytes)
          .digest('hex') !== sha
      )
        throw new Error('Contract blob does not match its Git object');
      this.bytes += bytes.length;
      if (this.bytes > MAX_FILE_BYTES) throw new Error('Contract input budget exceeded');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    };
    return async (path) => {
      if (!validContractPath(path)) throw new Error('Invalid contract path');
      const segments = path.split('/');
      let sha = await (root ??= rootTree());
      for (const [index, part] of segments.entries()) {
        if (!trees.has(sha)) trees.set(sha, tree(sha));
        const entry = (await trees.get(sha)!).find((candidate) => candidate?.path === part);
        if (!entry) return null;
        if (!shaPattern.test(entry.sha)) throw new Error('Invalid Git tree entry');
        sha = entry.sha;
        if (index + 1 < segments.length) {
          if (entry.type !== 'tree' || entry.mode !== '040000')
            throw new Error('Contract path crosses a link or submodule');
        } else if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
          throw new Error('Contract file must be a regular Git blob');
      }
      if (!blobs.has(sha)) blobs.set(sha, blob(sha));
      return blobs.get(sha)!;
    };
  }

  async publish(repository: string, expected: PullRequest, markdown: string) {
    if (
      !isRepository(repository) ||
      expected.base.repository.toLowerCase() !== repository.toLowerCase()
    )
      throw new Error('Invalid PR comment repository');
    const issue = '/repos/' + repository + '/issues/' + expected.number + '/comments';
    let id: number | undefined;
    let body: string | undefined;
    for (let page = 1; page <= 10; page++) {
      const comments = await this.json(issue + '?per_page=100&page=' + page);
      if (!Array.isArray(comments) || comments.length > 100)
        throw new Error('Invalid PR comment list');
      const previous = comments.find(
        (item) =>
          item?.user?.login === 'github-actions[bot]' &&
          item.user.type === 'Bot' &&
          typeof item.body === 'string' &&
          item.body.startsWith(commentMarker + '\n') &&
          Number.isSafeInteger(item.id) &&
          item.id > 0,
      );
      if (previous) {
        id = previous.id;
        body = previous.body;
        break;
      }
      if (comments.length < 100) break;
      if (page === 10) throw new Error('PR comment search limit exceeded');
    }
    if (!sameRevision(await this.pull(repository, expected.number), expected)) return 'stale';
    if (body === markdown) return 'unchanged';
    await this.json(
      id ? '/repos/' + repository + '/issues/comments/' + id : issue,
      id ? 'PATCH' : 'POST',
      { body: markdown },
    );
    return id ? 'updated' : 'created';
  }
}
