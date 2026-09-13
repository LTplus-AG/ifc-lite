/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `evaluateRegex` hook for `runBundleTests` (#4482): routes a manifest
 * test's `expect.regex` matcher to the isolated regex worker (see
 * `@/lib/extensions/regex-worker-client`), falling back to
 * `defaultRegexEvaluator` (the pre-#4482 synchronous, in-process check)
 * only when the worker itself could not be started — a CSP blocking module
 * workers, or no `Worker` at all (#4505 finding B; previously every
 * `expect.regex` matcher just failed there). Not unprotected: `runBundleTests`
 * (packages/extensions/src/testing/runner.ts) still applies the length cap
 * and catastrophic-backtracking shape heuristic unconditionally before
 * calling either evaluator — the fallback only loses the timeout bound and
 * main-thread eviction for a pattern that is merely slow, not one of those
 * known-catastrophic shapes. Any other rejection (timeout, worker crash,
 * disposed client) means the worker DID start, so it is surfaced as-is, not
 * re-run in-process.
 *
 * One instance per `ExtensionHostService`, shared across its
 * `runTests`/`revalidateForSdk` calls; each `evaluate()` call still spawns
 * its own worker (the client is stateless per-call). Lives beside `host.ts`
 * the way `host-commands.ts`/`host-exporters.ts` do, so the host stays
 * within its module-size budget.
 */

import { defaultRegexEvaluator, type RegexEvalResult } from '@ifc-lite/extensions';
import { createRegexWorkerClient, type RegexWorkerClient } from '@/lib/extensions/regex-worker-client';

export class HostRegexEvaluator {
  private readonly client: RegexWorkerClient;
  /** Set once `evaluate()` fails to start a worker at all — no retries on a
   * CSP-blocked / Worker-less page (#4505 finding B). */
  private unavailable = false;

  constructor(client: RegexWorkerClient = createRegexWorkerClient()) {
    this.client = client;
  }

  /** Bound, so it can be handed to `runBundleTests` as `evaluateRegex` directly. */
  readonly evaluate = async (pattern: string, text: string): Promise<RegexEvalResult> => {
    if (this.unavailable) return defaultRegexEvaluator(pattern, text);
    try {
      return await this.client.evaluate(pattern, text);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Cannot start regex worker')) {
        this.unavailable = true;
        console.warn(
          '[ext-host] regex worker unavailable — falling back to synchronous, ' +
          'in-process expect.regex evaluation (no timeout bound, runs on the main thread):',
          err,
        );
        return defaultRegexEvaluator(pattern, text);
      }
      throw err;
    }
  };

  /**
   * Un-poison the worker client (#4505 finding C): React StrictMode's
   * mount/cleanup/mount re-invokes `ExtensionHostService.init()` on the SAME
   * service instance after `dispose()`'s cleanup latched the client — mirrors
   * `useSpacePlateSessions.ts`'s `disposedRef` reset on its own (re)mount
   * effect. No-op if never disposed.
   */
  reset(): void {
    this.client.reset();
  }

  dispose(): void {
    this.client.dispose();
  }
}
