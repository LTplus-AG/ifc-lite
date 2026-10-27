/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshCollection } from '@ifc-lite/wasm';
import type { MeshData } from '@ifc-lite/geometry';

// TEMPORARY M2-B boundary: replace the session/event interfaces with generated
// pkg-retained d.ts imports when M2-A lands. This is §3.2's view-only contract;
// the unchanged default MeshCollection type describes shared storage. The start
// frame is NOT the default RtcFrame {x,y,z}: M2-A emits RetainedRtcFrame.
export interface RetainedRtcFrame { rtcOffset: Float64Array; needsShift: boolean }
export interface RetainedStart {
  kind: 'start';
  candidateIds: Uint32Array;
  frame: RetainedRtcFrame;
}
export interface RetainedPublished {
  kind: 'published';
  expressId: number;
  ifcType: string;
  marker: 'PresentationObligationsUnmet';
  obligationsUnmet: string[];
  meshes: MeshCollection;
}
export interface RetainedRefused {
  kind: 'refused';
  status: 'refused';
  expressId: number;
  ifcType: string;
  code: string;
  origin?: { site: string; entity?: number; cause: string };
  kernelStatus?: number;
}
export type RetainedSessionEvent = RetainedStart | RetainedPublished | RetainedRefused;
export interface RetainedRunOptions { ids?: Uint32Array; detail: 'view' }
export interface RetainedModelSession {
  run(bytes: Uint8Array, options: RetainedRunOptions,
    onEvent: (event: RetainedSessionEvent) => void): Promise<unknown>;
  free(): void;
}
export interface RetainedSessionModule {
  RetainedModelSession: new () => RetainedModelSession;
  get_memory(): WebAssembly.Memory;
}

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
  options: RetainedRunOptions;
}
export type RetainedHostResponse = { runId: number } & (RetainedHostEvent
  | { kind: 'error'; code: RetainedHostErrorCode; message: string });
export const RETAINED_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
