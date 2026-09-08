/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `scanIfcEntities` tries the worker scan, then falls through to the wasm
 * scan if the worker found nothing (`entityRefs.length === 0`). A worker
 * that detects a truncated file with no accepted entities returns
 * `malformedRecordCount: 1` alongside an empty `refs` array -- exactly the
 * shape that sends control on to the wasm branch next.
 *
 * `scanEntitiesFastBytes`/`scanEntitiesFast` (the wasm API) return refs and
 * nothing else, so that branch already zeroed `oversizedIdCount` rather than
 * carry an earlier path's number. Before this fix it did not do the same for
 * `malformedRecordCount`, so a wasm scan that ran cleanly still reported the
 * worker's stale 1 in the final result -- a real, well-formed file recovered
 * by wasm, sent back as if the scan had stopped early.
 *
 * Installs a global `Worker`, so it lives in its own file (see the header of
 * `worker-parser-source-sharing.test.ts` for why that must not leak).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { scanIfcEntities, type WasmScanApi } from '../src/entity-scanner.js';

const originalWorker = (globalThis as Record<string, unknown>).Worker;
const originalBlob = (globalThis as Record<string, unknown>).Blob;
const originalURL = (globalThis as Record<string, unknown>).URL;

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  (globalThis as Record<string, unknown>).Blob = originalBlob;
  if (originalURL === undefined) {
    delete (globalThis as Record<string, unknown>).URL;
  } else {
    (globalThis as Record<string, unknown>).URL = originalURL;
  }
});

describe('scanIfcEntities: the wasm fallback clears a stale worker malformedRecordCount', () => {
  it('reports malformedRecordCount 0 when wasm recovers after a worker scan found nothing', async () => {
    (globalThis as Record<string, unknown>).Blob = class {
      constructor(_parts: unknown[], _opts: unknown) {}
    };
    (globalThis as Record<string, unknown>).URL = {
      createObjectURL: () => 'blob:fake-url',
    };

    class FakeWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror: unknown = null;
      constructor(_url: string) {}
      postMessage(_msg: unknown) {
        // The worker's own copy of the scan hit a truncated record, found
        // nothing usable, and reported it -- the shape that sends
        // scanIfcEntities on to try the wasm scan next.
        const empty = new Uint32Array(0).buffer;
        this.onmessage?.({
          data: {
            ids: empty,
            offsets: empty,
            lengths: empty,
            lines: empty,
            types: [],
            count: 0,
            oversizedIds: 0,
            malformedRecords: 1,
          },
        });
      }
      terminate() {}
    }
    (globalThis as Record<string, unknown>).Worker = FakeWorker;

    const wasmApi: WasmScanApi = {
      scanEntitiesFastBytes: () => [
        { expressId: 1, type: 'IFCWALL', byteOffset: 0, byteLength: 20, lineNumber: 1 },
      ],
    };

    const buffer = new TextEncoder().encode("#1=IFCWALL($,$,$);\n").buffer;
    const result = await scanIfcEntities(buffer, { wasmApi });

    expect(result.scanPath).toBe('wasm');
    expect(result.entityRefs.map((r) => r.expressId)).toEqual([1]);
    expect(result.oversizedIdCount).toBe(0);
    expect(result.malformedRecordCount).toBe(0);
  });
});
