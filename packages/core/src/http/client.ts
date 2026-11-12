import { err, ok, type Result } from '../result';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly now?: () => number;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get current(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.opts.cooldownMs) {
      this.state = 'half_open';
    }
    return this.state;
  }

  canRequest(): boolean {
    return this.current !== 'open';
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure(): void {
    this.failures += 1;
    if (this.failures >= this.opts.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}

export type HttpError =
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network'; readonly cause: string }
  | { readonly kind: 'http_status'; readonly status: number }
  | { readonly kind: 'circuit_open' };
export interface RequestBoundary {
  readonly byteCap?: number;
  readonly addresses?: readonly string[];
  readonly deadline?: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly breaker?: BreakerOptions;
  readonly fetchImpl?: FetchLike;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class HttpClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly breaker: CircuitBreaker;

  constructor(options: HttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 200;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.breaker = new CircuitBreaker(
      options.breaker ?? { failureThreshold: 5, cooldownMs: 30_000 },
    );
  }

  get breakerState(): BreakerState {
    return this.breaker.current;
  }
  get requestTimeoutMs(): number {
    return this.timeoutMs;
  }

  async request(
    input: string,
    init?: RequestInit,
    boundary: RequestBoundary = {},
  ): Promise<Result<Response, HttpError | { kind: 'too_large'; bytes: number; limit: number }>> {
    if (!this.breaker.canRequest()) return err({ kind: 'circuit_open' });
    const deadline = Math.min(Date.now() + this.timeoutMs, boundary.deadline ?? Infinity);

    let last: Result<Response, HttpError> = err({ kind: 'network', cause: 'no attempt made' });
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (init?.signal?.aborted) return err({ kind: 'timeout' });
      const attempted = await this.attempt(input, init, boundary, deadline);
      if (!attempted.ok && attempted.error.kind === 'too_large') return attempted;
      last = attempted as Result<Response, HttpError>;
      if (last.ok) {
        this.breaker.onSuccess();
        return last;
      }
      const serverFault = isServerFault(last.error);
      if (serverFault && attempt < this.maxRetries) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return err({ kind: 'timeout' });
        const signal = init?.signal;
        let onAbort: (() => void) | undefined;
        try {
          await Promise.race([
            this.sleep(Math.min(this.backoff(attempt), remaining)),
            new Promise<void>((resolve) => {
              onAbort = resolve;
              signal?.addEventListener('abort', onAbort, { once: true });
              if (signal?.aborted) resolve();
            }),
          ]);
        } finally {
          if (onAbort) signal?.removeEventListener('abort', onAbort);
        }
        continue;
      }
      if (serverFault) this.breaker.onFailure();
      return last;
    }
    return last;
  }

  private backoff(attempt: number): number {
    return this.baseDelayMs * 2 ** attempt + Math.floor(this.random() * this.baseDelayMs);
  }

  private async attempt(
    input: string,
    init: RequestInit | undefined,
    boundary: RequestBoundary,
    deadline: number,
  ): Promise<Result<Response, HttpError | { kind: 'too_large'; bytes: number; limit: number }>> {
    if (Date.now() >= deadline) return err({ kind: 'timeout' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline - Date.now());
    try {
      const signal = init?.signal
        ? AbortSignal.any([controller.signal, init.signal])
        : controller.signal;
      const response = await (boundary.addresses && this.fetchImpl === fetch
        ? pinnedFetch(input, { ...init, signal }, boundary.addresses)
        : this.fetchImpl(input, { ...init, signal }));
      if (response.status >= 400) {
        await response.body?.cancel();
        return err({ kind: 'http_status', status: response.status });
      }
      if (!response.body) return ok(response);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const limit = boundary.byteCap ?? 64 * 1024 * 1024;
      const onAbort = () => void reader.cancel().catch(() => undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        while (true) {
          if (signal.aborted) return err({ kind: 'timeout' });
          const part = await reader.read();
          if (signal.aborted) return err({ kind: 'timeout' });
          if (part.done) break;
          if (bytes + part.value.byteLength > limit) {
            await reader.cancel();
            return err({ kind: 'too_large', bytes, limit });
          }
          bytes += part.value.byteLength;
          chunks.push(part.value);
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        reader.releaseLock();
      }
      return ok(
        new Response(Buffer.concat(chunks), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      );
    } catch (cause) {
      if (controller.signal.aborted || init?.signal?.aborted) return err({ kind: 'timeout' });
      return err({
        kind: 'network',
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function pinnedFetch(
  input: string,
  init: RequestInit,
  addresses: readonly string[],
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(input);
    const address = addresses[0];
    if (!address) {
      reject(new Error('missing checked address'));
      return;
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers)),
        signal: init.signal ?? undefined,
        lookup: (_host, options, callback) => {
          const family = isIP(address);
          if (typeof options === 'object' && options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      },
      (response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const status = response.statusCode ?? 500;
        if ([204, 205, 304].includes(status)) {
          response.resume();
          resolve(new Response(null, { status, headers }));
        } else {
          const encoding = headers.get('content-encoding');
          const decoder =
            encoding === 'gzip'
              ? createGunzip()
              : encoding === 'deflate'
                ? createInflate()
                : encoding === 'br'
                  ? createBrotliDecompress()
                  : undefined;
          const stream = decoder ? response.pipe(decoder) : response;
          if (decoder) {
            headers.delete('content-encoding');
            headers.delete('content-length');
            response.on('error', (error) => decoder.destroy(error));
            stream.on('close', () => response.destroy());
          }
          resolve(
            new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers }),
          );
        }
      },
    );
    request.on('error', reject);
    if (typeof init.body === 'string') request.end(init.body);
    else if (init.body == null) request.end();
    else request.destroy(new Error('Pinned request body must be a string'));
  });
}

function isServerFault(e: HttpError): boolean {
  return (
    e.kind === 'timeout' ||
    e.kind === 'network' ||
    (e.kind === 'http_status' && RETRYABLE_STATUS.has(e.status))
  );
}
