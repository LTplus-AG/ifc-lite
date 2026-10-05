/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan outline worker (#6871). Collecting the in-band points of a large scan
 * and tracing them cost about 0.4 s and 0.2 s per change, measured on a
 * 9.3 M point PLY (914 k points in a 2 m band). On the main thread that froze
 * the UI on every plane move or slider change. Here both run off it.
 *
 * Sources are cached by key: the main thread sends a source's points once
 * (structured clone, never transferred: they are the scan cache's own
 * buffers) and afterwards only its key. Every `trace` names the keys it uses,
 * and anything else is dropped from the cache.
 */

import { ensureWasm } from '@/lib/wasm/ensure-wasm';
import { runScanOutlineJob, type ScanOutlineJob, type ScanOutlineSource } from '@/lib/scan-outline/scan-outline-job';
import type { ScanOutlineLayer } from '@/lib/scan-outline/scan-outline';

/** A source as sent: the points on first use, then the key alone. */
export interface ScanOutlineSourceRef {
  key: number;
  source?: ScanOutlineSource;
}

export interface ScanOutlineWorkerRequest {
  type: 'trace';
  id: number;
  sources: ScanOutlineSourceRef[];
  job: Omit<ScanOutlineJob, 'sources'>;
}

export type ScanOutlineWorkerResponse =
  | { type: 'complete'; id: number; layer: ScanOutlineLayer }
  | { type: 'error'; id: number; message: string };

const cache = new Map<number, ScanOutlineSource>();

/** Resolve the request's sources against the cache, keeping only those. */
export function resolveSources(refs: readonly ScanOutlineSourceRef[], store: Map<number, ScanOutlineSource>): ScanOutlineSource[] {
  const keep = new Set(refs.map((r) => r.key));
  for (const key of [...store.keys()]) if (!keep.has(key)) store.delete(key);
  return refs.map((ref) => {
    if (ref.source) store.set(ref.key, ref.source);
    const source = store.get(ref.key);
    if (!source) throw new Error(`scan outline source ${ref.key} was never sent`);
    return source;
  });
}

const isWorkerScope =
  typeof self !== 'undefined' &&
  typeof (globalThis as { window?: unknown }).window === 'undefined' &&
  typeof (self as unknown as Worker).postMessage === 'function';

if (isWorkerScope) {
  self.onmessage = async (event: MessageEvent<ScanOutlineWorkerRequest>) => {
    const request = event.data;
    if (!request || request.type !== 'trace') return;
    try {
      await ensureWasm();
      const sources = resolveSources(request.sources, cache);
      const layer = runScanOutlineJob({ ...request.job, sources });
      (self as unknown as Worker).postMessage({ type: 'complete', id: request.id, layer } satisfies ScanOutlineWorkerResponse);
    } catch (error) {
      (self as unknown as Worker).postMessage({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      } satisfies ScanOutlineWorkerResponse);
    }
  };
}
