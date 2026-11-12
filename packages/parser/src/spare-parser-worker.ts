/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One spare parser worker, prepared while the page is idle so the next parse
 * does not pay the worker's start-up: loading, compiling and evaluating its
 * bundle (on a 2.5 MB model that start-up is most of the metadata time; the
 * parse itself is tens of milliseconds).
 *
 * Optionally the spare parses a small shipped sample once (`warmSource`, never
 * the user's file). That parse instantiates the engine through the worker's
 * normal path and compiles its scan and parse functions before the first real
 * file. The spare is handed out only after the warm parse has finished, so a
 * real parse never shares the worker with it.
 *
 * At most one spare exists. `WorkerParser` takes it for its next parse (and
 * terminates it when that parse ends, as it does any parser worker); the host
 * decides when to prepare another and when to release an unused one.
 */

/** Request id of the warm parse; real requests use `parse_<time>_<n>`. */
export const WARM_PARSE_ID = 'spare-warm-parse';

interface Spare {
  worker: Worker;
  ready: boolean;
  /** Settles a pending warm-up; a terminated worker never answers, so release must settle it. */
  settle?: (ok: boolean) => void;
}

let spare: Spare | null = null;

export interface SpareParserWorkerOptions {
  /** Creates the parser worker (defaults to the bundled one `WorkerParser` spawns). */
  spawn?: () => Worker;
  /** A small sample to parse once before the spare is handed out. */
  warmSource?: SharedArrayBuffer | null;
}

/** The bundled parser worker. Inline `new URL(..., import.meta.url)` is what makes Vite emit it as its own chunk. */
export function spawnParserWorker(): Worker {
  return new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' });
}

/** The same check as `WorkerParser.isSupported()`: workers, SharedArrayBuffer and cross-origin isolation. */
function parserWorkerSupported(): boolean {
  if (typeof Worker === 'undefined' || typeof SharedArrayBuffer === 'undefined') return false;
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
}

/**
 * Prepare the spare. Resolves `true` once it can be taken, `false` when one
 * already exists, the warm parse failed, or it was released first.
 */
export function prepareSpareParserWorker(options: SpareParserWorkerOptions = {}): Promise<boolean> {
  if (spare || (!options.spawn && !parserWorkerSupported())) return Promise.resolve(false);
  let worker: Worker;
  try {
    worker = (options.spawn ?? spawnParserWorker)();
  } catch {
    return Promise.resolve(false);
  }
  const entry: Spare = { worker, ready: false };
  spare = entry;
  if (!options.warmSource) {
    entry.ready = true;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      entry.settle = undefined;
      worker.onmessage = null;
      worker.onerror = null;
      if (spare !== entry) { resolve(false); return; } // released meanwhile
      if (ok) { entry.ready = true; resolve(true); return; }
      spare = null;
      worker.terminate();
      resolve(false);
    };
    entry.settle = finish;
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; id?: string } | null;
      if (!msg || msg.id !== WARM_PARSE_ID) return;
      if (msg.type === 'complete') finish(true);
      else if (msg.type === 'error') finish(false);
    };
    worker.onerror = () => finish(false);
    worker.postMessage({ type: 'parse', id: WARM_PARSE_ID, source: options.warmSource, indexTransport: 'packed-index-v1' });
  });
}

/** Whether a spare exists (ready or still warming up). */
export function hasSpareParserWorker(): boolean {
  return spare !== null;
}

/** Take the ready spare, or `null` (none, or still warming up). */
export function takeSpareParserWorker(): Worker | null {
  if (!spare?.ready) return null;
  const { worker } = spare;
  spare = null;
  return worker;
}

/** Terminate the spare, if any (an unused spare costs a worker and its engine memory). */
export function releaseSpareParserWorker(): void {
  const entry = spare;
  spare = null;
  entry?.worker.terminate();
  entry?.settle?.(false); // a pending warm-up resolves false instead of hanging
}
