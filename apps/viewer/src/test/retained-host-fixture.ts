/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Retained host protocol fixtures (#7955 M2-C). A `RetainedWorker` that
 * speaks the host protocol (`retained-protocol.ts`) on a script, for the real
 * `RetainedClient`. Protocol data only: no engine, kernel or geometry
 * implementation is imitated — the meshes are the already-extracted
 * `MeshData` the host posts, and nothing here computes them.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { RetainedWorker } from '@/lib/retained/retained-client';
import type { RetainedHostEvent, RetainedHostRequest, RetainedHostResponse } from '@/lib/retained/retained-protocol';

export type HostMessage = RetainedHostEvent | { kind: 'error'; code: 'engine_missing' | 'worker_crash'; message: string };

export class ScriptedHostWorker implements RetainedWorker {
  onmessage: RetainedWorker['onmessage'] = null;
  onerror: RetainedWorker['onerror'] = null;
  onmessageerror: RetainedWorker['onmessageerror'] = null;
  requests: RetainedHostRequest[] = [];
  terminated = 0;
  /** Posted, one per macrotask, after the run request arrives; the rest is up to `emit`. */
  constructor(private readonly script: HostMessage[] = []) {}
  postMessage(request: RetainedHostRequest): void {
    this.requests.push(request);
    let delay = 0;
    for (const message of this.script) setTimeout(() => this.emit(message, request.runId), delay++);
  }
  terminate(): void { this.terminated++; }
  emit(message: HostMessage, runId = this.requests.at(-1)?.runId ?? 0): void {
    if (this.terminated) return; // a terminated Worker posts nothing
    this.onmessage?.({ data: { ...message, runId } } as MessageEvent<RetainedHostResponse>);
  }
}

/** One triangle at `x`, as the host posts an extracted product. */
export function productMesh(expressId: number, x = 0): MeshData {
  return {
    expressId,
    ifcType: 'IfcWall',
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.8, 0.8, 0.8, 1],
  };
}

export function start(ids: number[], rtc: [number, number, number] = [0, 0, 0], needsShift = false): RetainedHostEvent {
  return { kind: 'start', candidateIds: new Uint32Array(ids), frame: { rtcOffset: new Float64Array(rtc), needsShift } };
}

export function published(expressId: number, x = 0): RetainedHostEvent {
  return {
    kind: 'published', expressId, ifcType: 'IfcWall', marker: 'PresentationObligationsUnmet',
    obligationsUnmet: ['OpeningClosure', 'IfcAppearance'], meshes: [productMesh(expressId, x)],
  };
}

export function refused(expressId: number, code: Extract<RetainedHostEvent, { kind: 'refused' }>['code'], origin?: { site: string; entity?: number; cause: string }): RetainedHostEvent {
  return { kind: 'refused', status: 'refused', expressId, ifcType: 'IfcWallStandardCase', code, ...(origin ? { origin } : {}) };
}

export const complete: RetainedHostEvent = { kind: 'complete', cancelled: false };

/** A STEP source as a real File (content is never parsed by these tests). */
export function stepFile(name = 'model.ifc', size?: number): File {
  const file = new File([new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;\n')], name);
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}
