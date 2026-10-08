/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread client of `workers/scanOutline.worker.ts` (#6871): one resident
 * worker for as long as the outline is on, latest-wins.
 *
 * At most one job is in the worker. A request that arrives while one runs
 * waits as the single queued job, replacing any job already queued; the
 * replaced one and the running one, once it returns, both resolve
 * `superseded`. A plane drag therefore traces the first and the last position
 * and nothing between, and no stale rings are delivered. `dispose()`
 * terminates the worker and resolves everything outstanding `superseded`.
 *
 * Without `Worker` (tests, old browsers) the same job runs in-process after
 * the wasm module is initialised, with the same latest-wins rule.
 */

import { ensureWasm } from '@/lib/wasm/ensure-wasm';
import type { ScanOutlineWorkerRequest, ScanOutlineWorkerResponse, ScanOutlineSourceRef } from '@/workers/scanOutline.worker';
import { runScanOutlineJob, type ScanOutlineJob, type ScanOutlineSource } from './scan-outline-job';
import type { ScanOutlineLayer } from './scan-outline';

export type ScanOutlineTraceResult =
  | { status: 'done'; layer: ScanOutlineLayer }
  | { status: 'failed'; message: string }
  | { status: 'superseded' };

export interface ScanOutlineTracer {
  trace(job: ScanOutlineJob): Promise<ScanOutlineTraceResult>;
  dispose(): void;
}

/** A worker that neither answers nor errors (killed by the OS) must not hang the layer. */
export const SCAN_OUTLINE_TIMEOUT_MS = 120_000;

type Resolve = (result: ScanOutlineTraceResult) => void;

export function createScanOutlineTracer(options: { inProcess?: boolean } = {}): ScanOutlineTracer {
  if (options.inProcess || typeof Worker === 'undefined') return inProcessTracer();
  return workerTracer();
}

function inProcessTracer(): ScanOutlineTracer {
  let latest = 0;
  let disposed = false;
  return {
    async trace(job) {
      const id = ++latest;
      try {
        await ensureWasm();
        if (disposed || id !== latest) return { status: 'superseded' };
        return { status: 'done', layer: runScanOutlineJob(job) };
      } catch (error) {
        return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
    },
    dispose() {
      disposed = true;
    },
  };
}

function workerTracer(): ScanOutlineTracer {
  let worker: Worker | null = null;
  let nextId = 0;
  let nextKey = 0;
  // One key per points buffer and content revision: a buffer rewritten in
  // place (new `revision`) gets a new key, so its points are sent again.
  const keys = new WeakMap<Float32Array, { key: number; revision: number | undefined }>();
  let sentKeys = new Set<number>();
  let running: { id: number; resolve: Resolve; timer: ReturnType<typeof setTimeout> } | null = null;
  let queued: { job: ScanOutlineJob; resolve: Resolve } | null = null;

  const reset = () => {
    worker?.terminate();
    worker = null;
    sentKeys = new Set();
  };

  const finish = (result: ScanOutlineTraceResult) => {
    if (!running) return;
    clearTimeout(running.timer);
    const done = running;
    running = null;
    // A newer request is waiting: this result is already stale.
    done.resolve(queued ? { status: 'superseded' } : result);
    if (queued) {
      const next = queued;
      queued = null;
      send(next.job, next.resolve);
    }
  };

  const spawn = (): Worker => {
    const w = new Worker(new URL('../../workers/scanOutline.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (event: MessageEvent<ScanOutlineWorkerResponse>) => {
      const message = event.data;
      if (!running || message?.id !== running.id) return;
      finish(message.type === 'complete'
        ? { status: 'done', layer: message.layer }
        : { status: 'failed', message: message.message });
    };
    w.onerror = (event) => {
      reset();
      finish({ status: 'failed', message: event.message || 'the scan outline worker crashed' });
    };
    return w;
  };

  const send = (job: ScanOutlineJob, resolve: Resolve) => {
    try {
      worker ??= spawn();
      const id = ++nextId;
      const refs: ScanOutlineSourceRef[] = job.sources.map((source: ScanOutlineSource) => {
        let entry = keys.get(source.positions);
        if (entry === undefined || entry.revision !== source.revision) {
          entry = { key: ++nextKey, revision: source.revision };
          keys.set(source.positions, entry);
        }
        const key = entry.key;
        const fresh = !sentKeys.has(key);
        sentKeys.add(key);
        // Only what the band test reads: no colours across the boundary. The
        // count and transform go every time: alignment and placement change
        // them without touching the points.
        const { positions, classifications, count, model, modelOutputsRenderFrame } = source;
        const ref: ScanOutlineSourceRef = { key, count, model, modelOutputsRenderFrame };
        if (fresh) ref.points = { positions, classifications };
        return ref;
      });
      const rest = {
        coordinateInfo: job.coordinateInfo, plane: job.plane, thickness: job.thickness,
        classMask: job.classMask, maxGap: job.maxGap,
      };
      const timer = setTimeout(() => {
        reset();
        finish({ status: 'failed', message: 'the scan outline worker stopped responding' });
      }, SCAN_OUTLINE_TIMEOUT_MS);
      running = { id, resolve, timer };
      // No transfer list: the points belong to the scan cache and the canvas.
      worker.postMessage({ type: 'trace', id, sources: refs, job: rest } satisfies ScanOutlineWorkerRequest);
    } catch (error) {
      reset();
      if (running) finish({ status: 'failed', message: String(error) });
      else resolve({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  };

  return {
    trace(job) {
      return new Promise<ScanOutlineTraceResult>((resolve) => {
        if (running) {
          queued?.resolve({ status: 'superseded' });
          queued = { job, resolve };
          return;
        }
        send(job, resolve);
      });
    },
    dispose() {
      queued?.resolve({ status: 'superseded' });
      queued = null;
      if (running) {
        clearTimeout(running.timer);
        running.resolve({ status: 'superseded' });
        running = null;
      }
      reset();
    },
  };
}
