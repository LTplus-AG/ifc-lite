/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Client for {@link ./overlay-parse.worker.ts}. See that file for why these
 * parses must not run on the main thread (#2183).
 *
 * Lifecycle: one worker is shared by every in-flight job so a load that
 * needs both grid and alignment lines pays a single WASM compile, and it is
 * terminated the moment the last job settles. Terminating is the whole
 * point — it is what returns the decode scratch and the never-shrinking
 * `WebAssembly.Memory` to the OS.
 */

import type {
  OverlayParseKind,
  OverlayParseRequest,
  OverlayParseResponse,
} from './overlay-parse.worker.js';

const EMPTY_F32 = new Float32Array(0);

let worker: Worker | null = null;
let nextRequestId = 1;
let inFlight = 0;
const pending = new Map<number, (response: OverlayParseResponse) => void>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL('./overlay-parse.worker.ts', import.meta.url), {
    type: 'module',
  });
  created.onmessage = (event: MessageEvent<OverlayParseResponse>) => {
    const resolve = pending.get(event.data.id);
    if (!resolve) return;
    pending.delete(event.data.id);
    resolve(event.data);
  };
  created.onerror = (event) => {
    // A worker-level failure never resolves the per-job listener, so settle
    // every outstanding job rather than hanging the overlay parse forever.
    const message = event.message || 'overlay parse worker failed';
    for (const [id, resolve] of pending) resolve({ id, ok: false, error: message });
    pending.clear();
  };
  worker = created;
  return created;
}

function releaseWorker(): void {
  inFlight--;
  if (inFlight > 0 || !worker) return;
  worker.terminate();
  worker = null;
  pending.clear();
}

/**
 * Parse a whole-source overlay line set off the main thread.
 *
 * Resolves to an empty array on any failure: these overlays are decoration,
 * and a model that cannot produce them must still load.
 */
export async function parseOverlayLines(
  kind: OverlayParseKind,
  source: Uint8Array,
): Promise<Float32Array> {
  if (typeof Worker === 'undefined') return EMPTY_F32;
  const id = nextRequestId++;
  inFlight++;
  try {
    const active = ensureWorker();
    const response = await new Promise<OverlayParseResponse>((resolve) => {
      pending.set(id, resolve);
      const request: OverlayParseRequest = { id, kind, source };
      // No transfer list: `source` is SAB-backed, so it is shared by
      // reference. Transferring would detach the viewer's own copy.
      active.postMessage(request);
    });
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[overlay-parse] ${kind} failed:`, response.error);
      return EMPTY_F32;
    }
    return response.verts;
  } finally {
    pending.delete(id);
    releaseWorker();
  }
}

export type { OverlayParseKind };
