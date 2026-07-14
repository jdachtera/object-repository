/**
 * Connection resilience for the SQL executor (PRODUCTION_ROADMAP.md "Connection resilience"): a
 * timeout on every driver call plus retry-with-backoff for transient failures — wrapped at the
 * `SqlExecutor` seam, which is the only layer that can retry *safely*.
 *
 * Safety by operation kind:
 *  - **reads** (`SELECT`) are idempotent → timeout + retry.
 *  - **writes** run through `run` only outside a transaction → timeout, but no retry (a retry could
 *    double-apply a statement that already executed before the connection dropped).
 *  - **transactions** are atomic → a failed one rolls back, leaving no partial state, so the *whole*
 *    unit is retried. Statements the callback issues on the tx-scoped executor are not re-wrapped
 *    (they're covered by retrying the transaction as a whole).
 */
import type { SqlExecutor } from "./SqlBackend.ts";

/** Thrown when a driver call exceeds `timeoutMs`. Retryable by default (the read may just be slow). */
export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Database operation timed out after ${timeoutMs}ms.`);
    this.name = "TimeoutError";
  }
}

export interface ResilienceOptions {
  /** Extra attempts for a retryable read/transaction after the first (default 3). */
  retries?: number;
  /** Per-operation timeout in ms; omitted → no timeout. */
  timeoutMs?: number;
  /** Base backoff before the first retry, in ms (default 50). */
  backoffMs?: number;
  /** Multiplier applied to the backoff each retry (default 2 — exponential). */
  backoffFactor?: number;
  /** Upper bound on a single backoff wait, in ms (default 2000). */
  maxBackoffMs?: number;
  /** Decide whether an error is transient. Defaults to timeouts + common connection error codes. */
  isRetryable?: (error: unknown) => boolean;
  /** Observe each retry (for logging/metrics). */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  /** Injectable delay (tests pass an instant one); defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Transient driver error codes worth retrying (Postgres connection class + libpq/socket + MySQL). */
const RETRYABLE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", // socket / DNS
  "08000", "08003", "08006", "08001", "08004", "57P01", // Postgres: connection_exception, admin shutdown
  "PROTOCOL_CONNECTION_LOST", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT" // MySQL
]);

function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRead = (sql: string): boolean => /^\s*select\b/i.test(sql);

/** Race `promise` against a timer, rejecting with `TimeoutError` if it wins (no-op when `ms` is undefined). */
function withTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Wrap a `SqlExecutor` with per-call timeout and safe retry-with-backoff. */
export function resilientExecutor(inner: SqlExecutor, options: ResilienceOptions = {}): SqlExecutor {
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 50;
  const backoffFactor = options.backoffFactor ?? 2;
  const maxBackoffMs = options.maxBackoffMs ?? 2000;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const sleep = options.sleep ?? defaultSleep;

  const withRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        attempt++;
        if (attempt > retries || !isRetryable(error)) throw error;
        const delayMs = Math.min(backoffMs * backoffFactor ** (attempt - 1), maxBackoffMs);
        options.onRetry?.({ attempt, error, delayMs });
        await sleep(delayMs);
      }
    }
  };

  const wrapped: SqlExecutor = {
    run: (sql, params) => {
      const operation = () => withTimeout(inner.run(sql, params), options.timeoutMs);
      return isRead(sql) ? withRetry(operation) : operation(); // reads retry; writes only time out
    }
  };
  // A transaction is atomic — a failure rolls it back, so retrying the whole unit is safe.
  if (inner.transaction) {
    const innerTx = inner.transaction.bind(inner);
    wrapped.transaction = (fn) => withRetry(() => innerTx(fn));
  }
  return wrapped;
}
