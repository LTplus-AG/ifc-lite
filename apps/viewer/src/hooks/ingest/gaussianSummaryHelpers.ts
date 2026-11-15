// SPDX-License-Identifier: MPL-2.0
import type { GaussianRangeSummarizer, GaussianSummaryPart } from './gaussianDecodeStream.js';

/** Helper workers for the decode worker's summary pass: at most two, leaving cores for the page. */
export function gaussianSummaryHelpers(file: File, cores = globalThis.navigator?.hardwareConcurrency ?? 2): { count: number; summarize: GaussianRangeSummarizer } {
  const count = Math.max(0, Math.min(2, cores - 2));
  return {
    count,
    summarize: ranges => Promise.all(ranges.map(([start, end]) => summarizeInHelper(file, start, end))),
  };
}

/** One range in a nested worker; null when no helper could start (the caller then summarizes it itself). */
function summarizeInHelper(file: File, start: number, end: number): Promise<GaussianSummaryPart | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./gaussianSummary.worker.ts', import.meta.url), { type: 'module' }); }
    catch { resolve(null); return; }
    const done = () => { worker.onmessage = worker.onerror = worker.onmessageerror = null; worker.terminate(); };
    worker.onerror = (event) => { event.preventDefault?.(); done(); resolve(null); };
    worker.onmessageerror = () => { done(); resolve(null); };
    worker.onmessage = (event: MessageEvent<{ ok: true; part: GaussianSummaryPart } | { ok: false; reason: string }>) => {
      done();
      if (event.data.ok) resolve(event.data.part);
      else reject(new Error(event.data.reason));
    };
    try { worker.postMessage({ file, start, end }); } catch { done(); resolve(null); }
  });
}
