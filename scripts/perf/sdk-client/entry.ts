/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { consume } from './consumer.js';
import { fixtures, type Family, type Receipt } from './contracts.js';
import { sha256 } from './identity.js';

interface Endpoint {
  prepare(input: File | ArrayBuffer, family: Family): Promise<void>;
  run(): Promise<Receipt>;
  abort(): void;
  receipt: Receipt | null;
}
declare global { interface Window { __canonicalPoolEndpoint: Endpoint } }
let prepared: { bytes: Uint8Array; family: Family } | undefined;
let used = false;
let preparing = false;
const controller = new AbortController();
window.__canonicalPoolEndpoint = {
  receipt: null,
  async prepare(input, family) {
    if (used || prepared || preparing) throw new Error('fresh first-file endpoint required');
    if (!Object.hasOwn(fixtures, family)) throw new Error('unknown fixture family');
    for (const key of Object.getOwnPropertyNames(globalThis)) {
      if (key.startsWith('__IFC_LITE_')) throw new Error(`nondefault SDK global present: ${key}`);
    }
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined' || typeof Worker === 'undefined'
      || (navigator.hardwareConcurrency ?? 0) < 2 || Reflect.has(window, '__TAURI_INTERNALS__')) {
      throw new Error('default web SAB worker pool unavailable');
    }
    preparing = true;
    try {
      const buffer = input instanceof File ? await input.arrayBuffer() : input;
      const bytes = new Uint8Array(buffer);
      const fixture = fixtures[family];
      if (bytes.byteLength !== fixture.bytes || await sha256(bytes) !== fixture.sha256) {
        throw new Error('exact public fixture mismatch');
      }
      prepared = { bytes, family };
    } finally { preparing = false; }
  },
  async run() {
    if (used || !prepared || controller.signal.aborted) throw new Error('prepared fresh endpoint required');
    used = true;
    const { bytes, family } = prepared;
    prepared = undefined;
    const receipt: Receipt = { status: 'running', family, events: 0, eventCounts: {}, retainedBytes: 0,
      bufferCount: 0, collectMs: 0, generatorDone: false, processorDisposed: false, workerMemory: [] };
    this.receipt = receipt;
    return consume(bytes, family, receipt, controller);
  },
  abort() { controller.abort(); },
};
