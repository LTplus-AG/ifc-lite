/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exact attribution of the mutations an SDK caller created (#5634).
 *
 * A `bim.mutate.batchAsync` scope stays open across awaits, so "every
 * mutation pushed while it was open" also sweeps up an edit the user made
 * by hand in the meantime (a property panel edit goes straight to the store,
 * never through the SDK backend). Instead, every backend call is tracked:
 * the mutations it pushes SYNCHRONOUSLY, which no UI edit can interleave
 * with, are added to each open capture. A batch scope and a flow run each
 * hold a capture, so both see only what came in through the backend.
 *
 * Captures are module-wide rather than per backend: the viewer has one
 * store, and an id pushed by another backend instance over it is still an
 * SDK write.
 */

import type { StoreApi } from './types.js';
import { mutationsSince, undoStackLengths } from '../../store/slices/mutation-batch-tags.js';

export interface BackendWriteCapture {
  /** Ids of the mutations created through the SDK backend while open. */
  readonly ids: ReadonlySet<string>;
  close(): void;
}

const openCaptures = new Set<Set<string>>();

export function openBackendWriteCapture(): BackendWriteCapture {
  const ids = new Set<string>();
  openCaptures.add(ids);
  return { ids, close: () => { openCaptures.delete(ids); } };
}

/** Runs one backend call, attributing the mutations it pushes to every open capture. */
export function trackBackendWrite<T>(store: StoreApi, call: () => T): T {
  if (openCaptures.size === 0) return call();
  const before = undoStackLengths(store.getState().undoStacks);
  try {
    return call();
  } finally {
    const created = mutationsSince(store.getState().undoStacks, before);
    for (const capture of openCaptures) for (const id of created) capture.add(id);
  }
}

/** `adapter` with every method routed through `trackBackendWrite`. */
export function withBackendWriteTracking<T extends object>(store: StoreApi, adapter: T): T {
  const tracked: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(adapter)) {
    tracked[name] = typeof member === 'function'
      ? (...args: unknown[]) => trackBackendWrite(store, () => member.apply(adapter, args))
      : member;
  }
  return tracked as T;
}
