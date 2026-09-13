/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread client for the manifest-test regex evaluation worker.
 *
 * Isolates `@ifc-lite/extensions`' bundle test runner's `expect.regex`
 * check from the viewer's main UI thread (#4482) via an injectable
 * `RegexEvaluator` (see `packages/extensions/src/testing/runner.ts`).
 * "Run tests" in ExtensionsPanel and "Run check" / "Re-run" in
 * RepairQueuePanel both funnel through `ExtensionHostService`, which
 * wires this client in as `evaluateRegex`.
 *
 * Spawns a worker per call — regex tests run infrequently (a manual
 * click, not a hot loop), so a long-lived instance would only pin
 * memory with nothing to show for it, mirroring the IDS validation
 * worker client's same call (`@/hooks/ids/idsWorkerClient.ts`).
 *
 * A `timeoutMs` bound (default below) is the actual fix for the issue:
 * it turns an unbounded hang into a bounded, terminate-able one, off
 * the main thread. It does not make a catastrophic pattern fast — a
 * pattern that backtracks exponentially still burns the full timeout
 * before the worker is torn down.
 *
 * Calls *within one `runBundleTests` run* are strictly sequential (each
 * test is awaited before the next starts) — but one `RegexWorkerClient`
 * is shared across the whole `ExtensionHostService`, whose `runTests`
 * (ExtensionsPanel) and `revalidateForSdk` (repair queue) can both call
 * `evaluate()` on it, so two evaluations CAN be in flight on the same
 * client at once (#4505 finding D). Each call still spawns its own
 * worker and keeps its own `settled`/`timer` closure, so the two
 * evaluations don't interfere with each other's result — but `id` is
 * assigned from a counter shared by the whole client so two concurrent
 * calls never share a value, and `dispose()`/cancellation tracks every
 * in-flight call's abort function in a `Set` rather than a single slot,
 * so cancelling one in-flight call (or disposing the client) can never
 * silently drop another. The response's `id` is checked against the
 * request that produced it, so a response that doesn't match (which
 * should not happen with a correct worker, but would with a buggy or
 * malicious one) is rejected outright rather than silently trusted.
 */

export interface RegexWorker {
  onmessage:
    | ((
        event: MessageEvent<
          | { id: number; matched: boolean }
          | { id: number; error: string; invalidPattern?: boolean }
        >,
      ) => void)
    | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: { id: number; pattern: string; text: string }): void;
  terminate(): void;
}

export interface RegexWorkerClient {
  evaluate(pattern: string, text: string): Promise<{ matched: boolean }>;
  dispose(): void;
  /**
   * Un-poisons a disposed client so it can be reused — see the
   * lifecycle note above `disposed` below. Idempotent; safe to call
   * on a client that was never disposed.
   */
  reset(): void;
}

const DEFAULT_TIMEOUT_MS = 2000;

export function createRegexWorkerClient(
  options: { workerFactory?: () => RegexWorker; timeoutMs?: number } = {},
): RegexWorkerClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const factory =
    options.workerFactory ??
    (() =>
      new Worker(new URL('../../workers/manifestRegex.worker.ts', import.meta.url), {
        type: 'module',
      }) as unknown as RegexWorker);

  // Lifecycle note (#4505 finding C): `dispose()` used to be a one-way
  // latch — once set, every future `evaluate()` rejected with "disposed"
  // for the rest of the client's life. `ExtensionHostProvider.tsx` calls
  // `dispose()` from an effect cleanup on a `service` (and therefore
  // this client) that survives React StrictMode's simulated
  // mount/cleanup/mount, which permanently poisoned the client in dev.
  // `reset()` clears the flag; callers that recreate the owning service
  // on every real mount (the common case) never need it, but a caller
  // whose object survives a StrictMode remount — the same shape as
  // `useSpacePlateSessions.ts`'s `disposedRef`, reset on that hook's own
  // (re)mount effect — calls it there.
  let disposed = false;
  let nextId = 1;
  const aborters = new Set<() => void>();

  return {
    dispose() {
      disposed = true;
      // Safe to iterate live: each `abort()` call synchronously deletes
      // only its OWN entry (the one currently being visited) via
      // `finish()` — rejection handlers run as a later microtask, so
      // nothing re-enters `aborters` during this loop.
      for (const abort of aborters) abort();
    },
    reset() {
      disposed = false;
    },
    evaluate(pattern, text) {
      if (disposed) return Promise.reject(new Error('Regex worker client disposed.'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        let worker: RegexWorker;
        try {
          worker = factory();
        } catch (err) {
          reject(new Error(`Cannot start regex worker: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abortSelf: () => void;

        const finish = (error?: Error, result?: { matched: boolean }) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          worker.terminate();
          aborters.delete(abortSelf);
          if (error) reject(error);
          else resolve(result!);
        };
        abortSelf = () => finish(new Error('Regex evaluation cancelled.'));
        aborters.add(abortSelf);

        timer = setTimeout(() => {
          finish(
            new Error(
              `Regex evaluation timed out after ${timeoutMs}ms (possible catastrophic backtracking).`,
            ),
          );
        }, timeoutMs);

        worker.onmessage = (event) => {
          const response = event.data;
          if (!response || response.id !== id || settled) return;
          if ('error' in response) {
            // Reconstruct the distinction the worker tagged onto the
            // response (see `manifestRegex.worker.ts`): a `SyntaxError`
            // means the author's pattern is genuinely malformed; any
            // other error (timeout, worker crash, unreadable message)
            // is a plain `Error`. `applyExpectations`
            // (`packages/extensions/src/testing/runner.ts`) branches on
            // `instanceof SyntaxError` to report the two differently
            // (#4505 finding A) — postMessage's structured clone drops
            // the original prototype, so this is the only place that
            // distinction can be restored.
            finish(
              response.invalidPattern
                ? new SyntaxError(response.error)
                : new Error(response.error),
            );
            return;
          }
          finish(undefined, { matched: response.matched });
        };
        worker.onerror = (event) => {
          finish(new Error(event.message || 'The regex worker stopped unexpectedly.'));
        };
        worker.onmessageerror = () => {
          finish(new Error('The regex worker returned unreadable data.'));
        };

        try {
          worker.postMessage({ id, pattern, text });
        } catch (err) {
          finish(new Error(`Failed to post regex job: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    },
  };
}
