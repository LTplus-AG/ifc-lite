/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
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
/** The `detail: 'view'` publication: the shape-only variant carries `parts`, not meshes. */
export type RetainedPublished = Extract<SessionEvent<'published'>, { meshes: unknown }>;
export type RetainedRefused = SessionEvent<'refused'>;

export type RetainedHostEvent = RetainedStart
  | (Omit<RetainedPublished, 'meshes'> & { meshes: MeshData[] })
  | RetainedRefused
  | { kind: 'workerMemory'; wasmHeapBytes: number }
  | { kind: 'complete'; cancelled: boolean }
  | { kind: 'cancelled'; expressId: number; code: 'cancelled' };
export type RetainedHostErrorCode = 'startup' | 'worker_crash' | 'engine_missing' | 'source_too_large' | 'busy';
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
export const RETAINED_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
