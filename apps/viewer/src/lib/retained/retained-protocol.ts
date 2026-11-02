/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { RetainedFaceRow } from '@/store/retainedGeometry';
import type {
  RetainedProductRefusal, RetainedRunOptions, RetainedSessionEvent,
} from '../../../../../packages/wasm/pkg-retained/ifc-lite.js';

// The session contract is M2-A's generated pkg-retained d.ts (type-only, so
// nothing of pkg-retained enters any bundle). Only the host protocol below is
// viewer-owned: what the host Worker posts after extracting view meshes.
export type { RetainedProductRefusal, RetainedRtcFrame, RetainedRunOptions, RetainedSessionEvent } from '../../../../../packages/wasm/pkg-retained/ifc-lite.js';
export type RetainedRefusalCode = RetainedProductRefusal['code'];
type SessionEvent<K extends RetainedSessionEvent['kind']> = Extract<RetainedSessionEvent, { kind: K }>;
export type RetainedStart = SessionEvent<'start'>;
/** The `detail: 'view'` publication: `detail: 'shape'` carries `parts` instead of meshes; either may be final. */
export type RetainedPublished = Extract<SessionEvent<'published'>, { meshes: unknown }>;
export type RetainedRefused = SessionEvent<'refused'>;
type PublishedMetadata = Omit<RetainedPublished, 'meshes'> & { faceRows?: RetainedFaceRow[] };

export type RetainedHostEvent = RetainedStart
  | (PublishedMetadata & { meshes: MeshData[]; instancedShards?: ArrayBuffer[];
      instanceProducts?: PublishedMetadata[];
      meshCount?: number; bounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } })
  | RetainedRefused
  | { kind: 'progress' }
  | { kind: 'workerMemory'; wasmHeapBytes: number }
  | { kind: 'complete'; cancelled: boolean }
  | { kind: 'cancelled'; expressId: number; code: 'cancelled' };
export type RetainedHostErrorCode = 'startup' | 'worker_crash' | 'engine_missing' | 'source_too_large' | 'out_of_memory' | 'busy';
export class RetainedHostError extends Error {
  constructor(readonly code: RetainedHostErrorCode, message: string) {
    super(`${message}. Reload with exact kernel`);
    this.name = 'RetainedHostError';
  }
}
export interface RetainedHostRequest {
  runId: number;
  bytes: Uint8Array;
  options: RetainedRunOptions & { detail: 'view' };
}
export type RetainedHostResponse = { runId: number } & (RetainedHostEvent
  | { kind: 'error'; code: RetainedHostErrorCode; message: string });
/**
 * The largest source the retained engine can start (#7955). The bytes enter its
 * wasm32 linear memory as one Rust `Vec<u8>`, and no wasm32 allocation may exceed
 * `isize::MAX`, so anything larger fails before any work. This is not a tuned
 * cap: below it, whether a model fits is decided by the engine's allocations,
 * and running out of memory ends the load with an `out_of_memory` refusal.
 * docs/architecture/retained-viewer-memory.md has the measurements.
 */
export const RETAINED_MAX_SOURCE_BYTES = 2 ** 31 - 1;

/** Where the engine's panic hook records a panic; kept in lockstep with `PANIC_STASH_KEY` in rust/wasm-bindings/src/utils.rs. */
export const RETAINED_PANIC_STASH_KEY = '__ifclite_wasm_panic';
const ALLOCATION_FAILURE = /out of memory|allocation failed|could not allocate|maximum memory size exceeded/i;

/**
 * Whether a host failure is the engine (or the source hand-off) running out of
 * memory. With `panic = "abort"` a Rust panic and a failed allocation both reach
 * JavaScript as the same `RuntimeError: unreachable`, but only a panic runs the
 * panic hook, which records its location (`utils.rs`). So a WebAssembly trap
 * with no panic recorded since the run began is an allocation failure; so is
 * any error that says it is (a failed structured clone, a failed `ArrayBuffer`).
 */
export function isAllocationFailure(error: unknown, panicked: boolean): boolean {
  if (panicked) return false;
  if (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) return true;
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return ALLOCATION_FAILURE.test(text);
}
