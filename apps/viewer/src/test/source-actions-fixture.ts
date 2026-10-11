/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #7160 real Bonsai geometry encoded by the canonical native IFNS producer.
import type { TestContext } from 'node:test';
import { ensureWasm } from './scan-slab-fixture';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { IfcAPI } from '@ifc-lite/wasm';
import { IfcParser } from '@ifc-lite/parser';
import { decodeInstancedShard } from '@ifc-lite/geometry';

interface PrePass {
  jobs: Uint32Array; unitScale: number; rtcOffset: number[]; needsShift: boolean;
  voidKeys: Uint32Array; voidCounts: Uint32Array; voidValues: Uint32Array;
  styleIds: Uint32Array; styleColors: Uint8Array;
}
export async function nativeSourceShard(t: TestContext) {
  if (!ensureWasm(t)) return null;
  const bytes = readFileSync(new URL('../../public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
  const api = new IfcAPI();
  try {
    const pre: PrePass = api.buildPrePassOnce(bytes);
    const shard = api.processGeometryBatchInstanced(bytes, pre.jobs, pre.unitScale,
      pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    const decoded = decodeInstancedShard(shard);
    assert.ok(decoded.instances.length > 0, 'native authored IFC produces real instanced occurrences');
    return { store, shard: new Uint8Array(shard).buffer };
  } finally { api.clearPrePassCache(); api.free(); }
}
