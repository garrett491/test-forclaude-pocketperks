/**
 * The database could not answer.
 *
 * Thrown instead of returning an empty result, because "no rows" and "the
 * query failed" must never look the same. Treating a failed lookup as an
 * empty one is what turned every business page into a "not found" whenever
 * a query broke — a silent failure nobody could diagnose from the outside.
 *
 * Pages catch this and show a friendly "try again" state with a 503 status
 * that the CDN never caches.
 */
export class DataUnavailableError extends Error {
  readonly context: string;
  readonly code: string | null;

  constructor(context: string, cause?: { code?: string; message?: string } | null) {
    super(`${context}: ${cause?.message ?? 'no response'}`);
    this.name = 'DataUnavailableError';
    this.context = context;
    this.code = cause?.code ?? null;
  }
}

/**
 * Unwraps a Supabase response, throwing when it carries an error.
 *
 * The message is logged server-side for debugging. It never reaches a
 * visitor: pages render their own plain-language notice instead.
 */
export function must<T>(
  context: string,
  result: { data: T | null; error: { code?: string; message?: string } | null }
): T {
  if (result.error) {
    logDataError(context, result.error);
    throw new DataUnavailableError(context, result.error);
  }
  return result.data as T;
}

export function logDataError(context: string, error: { code?: string; message?: string } | unknown) {
  const e = error as { code?: string; message?: string };
  // Code and message only. Never the request, never a key, never user input.
  console.error(`[pocket-perks] ${context} failed`, e?.code ?? '', String(e?.message ?? error).slice(0, 300));
}

export function isDataUnavailable(error: unknown): error is DataUnavailableError {
  return error instanceof DataUnavailableError;
}
