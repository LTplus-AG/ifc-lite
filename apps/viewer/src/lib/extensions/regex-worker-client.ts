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
 * Calls from `runBundleTests` are strictly sequential (each test is
 * awaited before the next starts), so unlike the PDF worker client
 * this one does not need a stale-response guard keyed on "is this the
 * latest call" — there is never more than one in-flight evaluation to
 * disambiguate. The response's `id` is still checked against the
 * request that was sent, so a response that doesn't match the
 * in-flight request (which should not happen with a correct worker,
 * but would with a buggy or malicious one) is rejected outright rather
 * than silently trusted.
 */

export interface RegexWorker {
  onmessage: ((event: MessageEvent<{ id: number; matched: boolean } | { id: number; error: string }>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: { id: number; pattern: string; text: string }): void;
  terminate(): void;
}

export interface RegexWorkerClient {
  evaluate(pattern: string, text: string): Promise<{ matched: boolean }>;
  dispose(): void;
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

  let disposed = false;
  let abortCurrent: (() => void) | undefined;

  return {
    dispose() {
      disposed = true;
      abortCurrent?.();
    },
    evaluate(pattern, text) {
      if (disposed) return Promise.reject(new Error('Regex worker client disposed.'));
      const id = 1;
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

        const finish = (error?: Error, result?: { matched: boolean }) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          worker.terminate();
          abortCurrent = undefined;
          if (error) reject(error);
          else resolve(result!);
        };
        abortCurrent = () => finish(new Error('Regex evaluation cancelled.'));

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
            finish(new Error(response.error));
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
