/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hold parser store publications while the geometry tail (upload queue drain
 * and renderer finalize) runs, then publish only the newest store.
 *
 * Every publication costs the main thread: hydration, the store commit, the
 * React render of the panels that read the store, and their derived values.
 * The parser worker publishes twice, a partial store when the spatial
 * hierarchy is ready and the full store when the parse completes. On a large
 * cold load both used to land inside the geometry tail, which also runs on the
 * main thread, so the tail stretched by the full cost of both publications.
 * Measured (traced, sourcemapped, main+#9684+#9747): renderer finalize did
 * ~210 ms of work in every load but took 555-798 ms when the publications
 * landed inside it; the partial publication alone was ~250 ms (BWK) to ~500 ms
 * (Holter) of main-thread time, all of it discarded by the full store moments later.
 *
 * Outside the tail (during streaming, or once it has finished) publications pass
 * straight through, so a store that is ready before geometry is not delayed.
 * A held store is released when the tail ends, or after `maxHoldMs` so a
 * finalize that never ends (device loss keeps its fragments) cannot park metadata.
 */

/**
 * Holding pays only on large loads. Held, a store's commit runs after the tail
 * instead of inside it, which saves time only when the tail keeps the main
 * thread saturated (Holter: a 2.6 s upload drain at 100% main) or a redundant
 * partial store is dropped. On a small scene the tail is a few frames with idle
 * time between them, the commit fits into that idle time, and holding it only
 * delays it: with the small-file fast path (#9900) FZK's parser finishes at
 * ~311 ms, before its ~400-490 ms tail, so a hold would move interactive later.
 * The boundary is the loader's existing large-load size (the entity-index
 * deferral), below which every load publishes at once as before this gate.
 */
export const METADATA_HOLD_MIN_MB = 32;

/** Whether this load's store publications may be held during the geometry tail. */
export function holdsMetadataDuringTail(fileSizeMB: number): boolean {
  return fileSizeMB >= METADATA_HOLD_MIN_MB;
}

export interface MetadataPublishGate<S> {
  /** The partial (hierarchy-ready) store. Dropped if the full store overtakes it while held. */
  partial(store: S): void;
  /** The complete store. Always published, at most once. */
  full(store: S): void;
}

export interface MetadataPublishGateOptions<S> {
  /** True while the geometry tail (queued uploads, streaming fragments, finalize) is running. */
  isTailBusy: () => boolean;
  publishPartial: (store: S) => void;
  publishFull: (store: S) => void;
  pollMs?: number;
  maxHoldMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export function createMetadataPublishGate<S>(options: MetadataPublishGateOptions<S>): MetadataPublishGate<S> {
  const pollMs = options.pollMs ?? 16;
  const maxHoldMs = options.maxHoldMs ?? 3_000;
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let heldPartial: S | undefined;
  let heldFull: S | undefined;
  let fullDone = false;
  let heldSince = -1;
  let armed = false;

  const release = (): void => {
    armed = false;
    heldSince = -1;
    const full = heldFull, partial = heldPartial;
    heldFull = undefined; heldPartial = undefined;
    if (full !== undefined) options.publishFull(full);
    else if (partial !== undefined) options.publishPartial(partial);
  };
  const poll = (): void => {
    if (!options.isTailBusy() || now() - heldSince >= maxHoldMs) { release(); return; }
    setTimer(poll, pollMs);
  };
  const hold = (): void => {
    if (armed) return;
    armed = true;
    heldSince = now();
    setTimer(poll, pollMs);
  };

  return {
    partial(store) {
      if (fullDone) return;
      if (!armed && !options.isTailBusy()) { options.publishPartial(store); return; }
      heldPartial = store;
      hold();
    },
    full(store) {
      if (fullDone) return;
      fullDone = true;
      if (!armed && !options.isTailBusy()) { options.publishFull(store); return; }
      heldFull = store;
      hold();
    },
  };
}
