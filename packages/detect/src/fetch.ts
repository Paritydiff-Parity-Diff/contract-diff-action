import { err, ok, type HttpClient, type HttpError, type Result } from '@paritydiff/core';
import { assertWithinByteCap, DEFAULT_BYTE_CAP } from './limits';
import { resolveSafeUrl, type SsrfError, type SsrfOptions } from './ssrf';

// Credential for a private spec URL. token is the already-resolved plaintext (the secret
// store decrypts it upstream); for basic it is the raw "user:pass" string, encoded here.
export interface SpecAuth {
  readonly scheme: 'bearer' | 'basic' | 'token';
  readonly token: string;
}

export interface FetchSpecOptions {
  readonly ssrf: SsrfOptions;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly byteCap?: number;
  readonly auth?: SpecAuth;
  readonly deadline?: number;
  readonly bodyEncoding?: 'utf8' | 'base64';
}

function authHeader(auth: SpecAuth): string {
  if (auth.scheme === 'basic') return `Basic ${Buffer.from(auth.token, 'utf8').toString('base64')}`;
  if (auth.scheme === 'token') return `token ${auth.token}`;
  return `Bearer ${auth.token}`;
}

export type FetchOutcome =
  | { readonly status: 'unchanged' }
  | { readonly status: 'rate_limited' }
  | {
      readonly status: 'fetched';
      readonly body: string;
      readonly etag?: string;
      readonly lastModified?: string;
    };

export type FetchSpecError =
  | { readonly kind: 'ssrf'; readonly error: SsrfError }
  | { readonly kind: 'http'; readonly error: HttpError }
  | { readonly kind: 'too_large'; readonly bytes: number; readonly limit: number };

export interface SpecFetcherRetry {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

// Conditional, well-behaved spec fetch (spec section 9.1 etiquette): SSRF check
// at the boundary, identifying User-Agent, If-None-Match/If-Modified-Since with a
// 304 fast path, a byte cap on the body, and 429 surfaced as rate_limited.
export class SpecFetcher {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly http: HttpClient,
    private readonly userAgent: string,
    retry: SpecFetcherRetry = {},
  ) {
    this.maxRetries = retry.maxRetries ?? 3;
    this.baseDelayMs = retry.baseDelayMs ?? 200;
    this.sleep = retry.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async fetch(
    url: string,
    options: FetchSpecOptions,
  ): Promise<Result<FetchOutcome, FetchSpecError>> {
    const deadline = Math.min(
      Date.now() + this.http.requestTimeoutMs,
      options.deadline ?? Infinity,
    );
    if (Date.now() >= deadline) return err({ kind: 'http', error: { kind: 'timeout' } });
    // HttpClient already retries HTTP faults; DNS resolution in the SSRF check does
    // not, so a transient resolver blip (EAI_AGAIN) fails the whole poll round. Retry
    // only that transient case with backoff; every other SSRF verdict is permanent.
    let safe = await resolveSafeUrl(url, {
      ...options.ssrf,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    for (
      let attempt = 0;
      !safe.ok && safe.error.kind === 'resolution_failed' && attempt < this.maxRetries;
      attempt += 1
    ) {
      if (Date.now() >= deadline) return err({ kind: 'http', error: { kind: 'timeout' } });
      await this.sleep(Math.min(this.baseDelayMs * 2 ** attempt, deadline - Date.now()));
      safe = await resolveSafeUrl(url, {
        ...options.ssrf,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    }
    if (!safe.ok) return err({ kind: 'ssrf', error: safe.error });

    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: 'application/json, application/yaml;q=0.9, */*;q=0.5',
    };
    if (options.etag) headers['if-none-match'] = options.etag;
    if (options.lastModified) headers['if-modified-since'] = options.lastModified;
    if (options.auth) headers['authorization'] = authHeader(options.auth);

    if (Date.now() >= deadline) return err({ kind: 'http', error: { kind: 'timeout' } });
    const response = await this.http.request(
      safe.value.url.toString(),
      {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      },
      { byteCap: options.byteCap ?? DEFAULT_BYTE_CAP, addresses: safe.value.addresses, deadline },
    );
    if (!response.ok) {
      if (response.error.kind === 'too_large') return err(response.error);
      if (response.error.kind === 'http_status' && response.error.status === 429) {
        return ok({ status: 'rate_limited' });
      }
      return err({ kind: 'http', error: response.error });
    }
    if (response.value.status === 304) return ok({ status: 'unchanged' });
    if (response.value.status >= 300)
      return err({ kind: 'http', error: { kind: 'http_status', status: response.value.status } });

    const binary =
      options.bodyEncoding === 'base64'
        ? Buffer.from(await response.value.arrayBuffer())
        : undefined;
    const body = binary ? binary.toString('base64') : await response.value.text();
    const bytes = binary?.byteLength ?? Buffer.byteLength(body, 'utf8');
    const cap = assertWithinByteCap(bytes, options.byteCap ?? DEFAULT_BYTE_CAP);
    if (!cap.ok) return err({ kind: 'too_large', bytes, limit: cap.error.limit });

    const etag = response.value.headers.get('etag');
    const lastModified = response.value.headers.get('last-modified');
    return ok({
      status: 'fetched',
      body,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    });
  }
}
