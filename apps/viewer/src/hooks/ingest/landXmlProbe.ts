/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LandXmlSourceBuffer } from './landXmlIngest.js';
import type { LandXmlAlignmentInspectionResult, LandXmlAlignmentProbeResult } from './landXmlAlignmentWasm.js';

export interface LandXmlAlignmentProbeRequest {
  alignmentSourceId: string;
  mode: 'distance' | 'station';
  value: number;
  offsetRight: number;
}

export interface LandXmlAlignmentProbeResponse {
  probes: LandXmlAlignmentProbeResult[];
  inspection: LandXmlAlignmentInspectionResult;
}

type ProbeWorkerResponse =
  | { ok: true; probes: LandXmlAlignmentProbeResult[]; inspection: LandXmlAlignmentInspectionResult }
  | { ok: false; error: string };

/**
 * Run source reparsing and displayed-station expansion off the UI thread.
 * Terminating this per-request worker makes an abandoned probe cancellable even
 * while synchronous WASM is executing.
 */
export function probeLandXmlAlignmentInWorker(
  buffer: LandXmlSourceBuffer,
  request: LandXmlAlignmentProbeRequest,
  signal: AbortSignal,
): Promise<LandXmlAlignmentProbeResponse> {
  if (typeof Worker === 'undefined') {
    return Promise.reject(new Error('LandXML alignment probing requires a worker-capable browser.'));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./landXmlProbe.worker.ts', import.meta.url), { type: 'module' });
    let complete = false;
    const finish = (): boolean => {
      if (complete) return false;
      complete = true;
      signal.removeEventListener('abort', abort);
      worker.terminate();
      return true;
    };
    const abort = () => {
      if (finish()) reject(new Error('LandXML alignment probe cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<ProbeWorkerResponse>) => {
      if (!finish()) return;
      if (event.data.ok) resolve({ probes: event.data.probes, inspection: event.data.inspection });
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      if (finish()) reject(new Error(event.message || 'LandXML alignment probe worker failed'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    const transferable = typeof SharedArrayBuffer === 'undefined' || !(buffer instanceof SharedArrayBuffer);
    worker.postMessage({ buffer, ...request }, transferable ? [buffer] : []);
  });
}
