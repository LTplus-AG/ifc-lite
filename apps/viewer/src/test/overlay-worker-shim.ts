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

  /** Mirrors the real worker's serial queue. */
  let queue: Promise<void> = Promise.resolve();

  /** Reply routers keyed by request id, so concurrent jobs cannot cross. */
  const inFlightById = new Map<number, (reply: unknown) => void>();

  // One persistent `self` for the shim's lifetime.
  g.self = {
    postMessage: (reply: unknown) => {
      const route = inFlightById.get((reply as { id: number }).id);
      route?.(reply);
    },
  };

  class InProcessOverlayWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;

    postMessage(request: unknown): void {
      // The client dispatches jobs concurrently, so `self` must NOT be
      // swapped per call: a first call restoring it while a second is still
      // running would leave the second unable to post any reply at all.
      // Instead `self` is installed once for the shim's lifetime and routes
      // each reply back by request id.
      const { id } = request as { id: number };
      inFlightById.set(id, (reply) => {
        // Async delivery and a real clone, exactly like a worker hop.
        queueMicrotask(() => this.onmessage?.({ data: structuredClone(reply) }));
      });
      // Chain onto the same queue the real worker uses. Calling `handle`
      // directly would let concurrent jobs each initialise WASM at once —
      // exactly the double-instantiation the worker's serialisation exists to
      // prevent — so an unserialised shim would not model the real thing.
      queue = queue
        .then(() => handle({ data: request } as never))
        .catch((error: unknown) => {
          this.onerror?.({ message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          inFlightById.delete(id);
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
