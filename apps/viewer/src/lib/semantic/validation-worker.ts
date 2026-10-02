/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ValidationJob, ValidationOutput } from './validation-job';
export interface ValidationWorker {
  postMessage(job: ValidationJob): void; terminate(): void;
  onerror: ((event: ErrorEvent) => unknown) | null;
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null;
}
/** Each bounded job owns its worker; every completion path frees it exactly once. */
export function validateInWorker(job: ValidationJob, signal: AbortSignal,
  createWorker: () => ValidationWorker = () => new Worker(new URL('./semantic.worker.ts', import.meta.url), { type: 'module' })): Promise<ValidationOutput> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const worker = createWorker(); let settled = false;
    const finish = (error?: Error, result?: ValidationOutput) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      worker.onmessage = null; worker.onerror = null; worker.terminate();
      if (error) reject(error); else if (result) resolve(result);
    };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Semantic validation exceeded 15 seconds')), 15_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = event => finish(new Error(event.message || 'Semantic worker failed'));
    worker.onmessage = event => {
      const data = event.data;
      if (!data || typeof data !== 'object' || !('ok' in data)) { finish(new Error('Malformed semantic worker response')); return; }
      if (data.ok !== true) { finish(new Error('error' in data && typeof data.error === 'string' ? data.error : 'Semantic validation failed')); return; }
      const value = 'value' in data ? data.value : undefined;
      if (!value || typeof value !== 'object' || !('graph' in value) || typeof value.graph !== 'string' || !('findings' in value) || !Array.isArray(value.findings)) { finish(new Error('Malformed semantic worker result')); return; }
      finish(undefined, value as ValidationOutput);
    };
    if (signal.aborted) { abort(); return; }
    try { worker.postMessage(job); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
