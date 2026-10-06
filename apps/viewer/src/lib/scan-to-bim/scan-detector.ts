/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread client of `workers/scanDetect.worker.ts` (#6894): cancellable
 * and latest-wins.
 *
 * Segmentation is one synchronous wasm call, so the only way to stop it is to
 * terminate the worker. A new `detect` while one runs terminates it (the old
 * run resolves `superseded`) and starts the new one on a fresh worker;
 * `cancel()` terminates it and resolves `cancelled`. The idle worker stays
 * resident between runs so wasm compiles once.
 *
 * The points are copied once (the sample's filled prefix) and the copy is
 * transferred: the scan cache keeps its own buffer.
 *
 * Without `Worker` (tests, old browsers) the job runs in-process after the
 * wasm module is initialised; a newer call or `cancel()` then only discards
 * the older result.
 */

import { ensureWasm } from '@/lib/wasm/ensure-wasm';
import type { ScanDetectWorkerRequest, ScanDetectWorkerResponse } from '@/workers/scanDetect.worker';
import { runScanDetectJob, type ScanDetectJob, type ScanDetectResult, type ScanDetectStage } from './detect-job';

export type ScanDetectOutcome =
  | { status: 'done'; result: ScanDetectResult }
  | { status: 'failed'; message: string }
  | { status: 'superseded' }
  | { status: 'cancelled' };

export interface ScanDetector {
  detect(job: ScanDetectJob, onStage?: (stage: ScanDetectStage) => void): Promise<ScanDetectOutcome>;
  cancel(): void;
  dispose(): void;
}

/** A worker the OS killed neither answers nor errors: give up after this. */
export const SCAN_DETECT_TIMEOUT_MS = 600_000;

type Settle = (outcome: ScanDetectOutcome) => void;

export function createScanDetector(options: { inProcess?: boolean } = {}): ScanDetector {
  if (options.inProcess || typeof Worker === 'undefined') return inProcessDetector();
  return workerDetector();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inProcessDetector(): ScanDetector {
  let latest = 0;
  let pending: { id: number; settle: Settle } | null = null;
  const drop = (outcome: ScanDetectOutcome) => {
    pending?.settle(outcome);
    pending = null;
  };
  return {
    detect(job, onStage) {
      drop({ status: 'superseded' });
      const id = ++latest;
      return new Promise<ScanDetectOutcome>((resolve) => {
        let settled = false;
        const settle: Settle = (outcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        pending = { id, settle };
        ensureWasm()
          .then(() => {
            if (id !== latest || settled) return;
            const result = runScanDetectJob(job, onStage);
            if (pending?.id === id) pending = null;
            settle({ status: 'done', result });
          })
          .catch((error: unknown) => settle({ status: 'failed', message: message(error) }));
      });
    },
    cancel() {
      latest++;
      drop({ status: 'cancelled' });
    },
    dispose() {
      latest++;
      drop({ status: 'superseded' });
    },
  };
}

function workerDetector(): ScanDetector {
  let worker: Worker | null = null;
  let nextId = 0;
  let running: { id: number; settle: Settle; onStage?: (stage: ScanDetectStage) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  const stop = (outcome: ScanDetectOutcome) => {
    if (!running) return;
    clearTimeout(running.timer);
    const done = running;
    running = null;
    done.settle(outcome);
  };

  const kill = (outcome: ScanDetectOutcome) => {
    worker?.terminate();
    worker = null;
    stop(outcome);
  };

  const spawn = (): Worker => {
    const w = new Worker(new URL('../../workers/scanDetect.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (event: MessageEvent<ScanDetectWorkerResponse>) => {
      const reply = event.data;
      if (!running || reply?.id !== running.id) return;
      if (reply.type === 'progress') running.onStage?.(reply.stage);
      else if (reply.type === 'complete') stop({ status: 'done', result: reply.result });
      else stop({ status: 'failed', message: reply.message });
    };
    w.onerror = (event) => kill({ status: 'failed', message: event.message || 'the scan detection worker crashed' });
    return w;
  };

  return {
    detect(job, onStage) {
      // A run in flight cannot be interrupted any other way.
      if (running) kill({ status: 'superseded' });
      return new Promise<ScanDetectOutcome>((resolve) => {
        try {
          worker ??= spawn();
          const id = ++nextId;
          const positions = job.positions.slice(0, job.count * 3);
          const timer = setTimeout(() => kill({ status: 'failed', message: 'the scan detection worker stopped responding' }), SCAN_DETECT_TIMEOUT_MS);
          running = { id, settle: resolve, onStage, timer };
          const request: ScanDetectWorkerRequest = { type: 'detect', id, job: { ...job, positions } };
          worker.postMessage(request, [positions.buffer]);
        } catch (error) {
          kill({ status: 'failed', message: message(error) });
          resolve({ status: 'failed', message: message(error) });
        }
      });
    },
    cancel() {
      if (running) kill({ status: 'cancelled' });
    },
    dispose() {
      kill({ status: 'superseded' });
    },
  };
}
