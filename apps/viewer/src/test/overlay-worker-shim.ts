/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only `Worker` stand-in that runs the real overlay-parse handler
 * in-process (#2183).
 *
 * Node has no `Worker`, so `parseOverlayLines` / `parseSymbolicFlat` resolve
 * empty there by design — a model must still load when the worker cannot
 * start. That is right for production but it silently guts any test that
 * drives a hook end-to-end and expects real parsed content.
 *
 * A stub returning canned data would test nothing. This runs the ACTUAL
 * `handle()` from the worker module and passes the reply through
 * `structuredClone`, so the flatten, the transferable layout and the
 * main-side reassembly are all genuinely exercised — the same boundary a real
 * `postMessage` imposes.
 *
 * Deliberately NOT a production fallback: adding one would reintroduce the
 * main-thread WASM heap this whole change exists to remove, on exactly the
 * flaky machines where the worker fails to start.
 */

import { handle } from '@/lib/overlay-parse/overlay-parse.worker.js';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse/index.js';

type Slot = { postMessage?: unknown };

/**
 * Install the shim. Returns a restore function; call it in `after()`.
 */
export function installInProcessOverlayWorker(): () => void {
  const g = globalThis as unknown as { self?: Slot };
  const previousSelf = g.self;

  class InProcessOverlayWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;

    postMessage(request: unknown): void {
      // `handle` posts its reply through `self.postMessage`, so point `self`
      // at this instance for the duration of the call.
      const saved = g.self;
      g.self = {
        postMessage: (reply: unknown) => {
          // Async delivery and a real clone, exactly like a worker hop.
          queueMicrotask(() => this.onmessage?.({ data: structuredClone(reply) }));
        },
      };
      void Promise.resolve(handle({ data: request } as never))
        .catch((error: unknown) => {
          this.onerror?.({ message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          g.self = saved;
        });
    }

    terminate(): void {
      /* nothing to tear down in-process */
    }
  }

  // Scoped to the overlay client. Setting a global `Worker` would also
  // convince the PARSER that workers are available.
  __setOverlayWorkerFactoryForTest(() => new InProcessOverlayWorker() as unknown as Worker);
  return () => {
    __setOverlayWorkerFactoryForTest(null);
    g.self = previousSelf;
  };
}
