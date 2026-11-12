export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

// Extract the value/error type from a Result even when it is a union, so the
// combinators below infer cleanly from a Result<T, E> variable, not just from a
// freshly constructed ok()/err().
type OkValue<R> = R extends Ok<infer T> ? T : never;
type ErrValue<R> = R extends Err<infer E> ? E : never;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

export function map<R extends Result<unknown, unknown>, U>(
  r: R,
  fn: (value: OkValue<R>) => U,
): Result<U, ErrValue<R>> {
  return r.ok ? ok(fn(r.value as OkValue<R>)) : (r as Err<ErrValue<R>>);
}

export function mapErr<R extends Result<unknown, unknown>, F>(
  r: R,
  fn: (error: ErrValue<R>) => F,
): Result<OkValue<R>, F> {
  return r.ok ? (r as Ok<OkValue<R>>) : err(fn(r.error as ErrValue<R>));
}

export function andThen<R extends Result<unknown, unknown>, U, F>(
  r: R,
  fn: (value: OkValue<R>) => Result<U, F>,
): Result<U, ErrValue<R> | F> {
  return r.ok ? fn(r.value as OkValue<R>) : (r as Err<ErrValue<R>>);
}

export function unwrapOr<R extends Result<unknown, unknown>>(
  r: R,
  fallback: OkValue<R>,
): OkValue<R> {
  return r.ok ? (r.value as OkValue<R>) : fallback;
}
