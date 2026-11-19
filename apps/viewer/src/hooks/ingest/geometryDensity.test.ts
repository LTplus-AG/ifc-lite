/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { denseRecordBytes, sampleDenseGeometryShare } from './geometryDensity.js';
import { inspectLocalIfcAdmission } from './localIfcAdmission.js';
import { createLocalIfcLoadAdmission } from './confirmLocalIfcAdmission.js';

// #10264: admission estimates peak memory from the file size, scaled up for dense triangulated
// geometry, which the size-only estimate admitted and then crashed on (synthetic tfs-300 at a
// reported 4 GB, 3 GiB cap, #10415). Records follow scripts/perf/gen-dense-ifc.mjs's two kinds.

const HEADER = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
const points = (n: number) => Array.from({ length: n }, (_, i) => `(${i}.125,${i}.5,${i}.75)`).join(',');
/** One tfs element: a point list and its face set, as gen-dense-ifc --kind tfs writes them. */
const tfsElement = (id: number) => `#${id}=IFCCARTESIANPOINTLIST3D((${points(400)}));\n`
  + `#${id + 1}=IFCTRIANGULATEDFACESET(#${id},$,.T.,(${Array.from({ length: 700 }, (_, i) => `(${i + 1},${i + 2},${i + 3})`).join(',')}),$);\n`
  + `#${id + 2}=IFCSHAPEREPRESENTATION(#9,'Body','Tessellation',(#${id + 1}));\n`;
/** One brep element: points, loops, bounds and faces, as --kind brep writes them. */
const brepElement = (id: number) => Array.from({ length: 60 }, (_, i) => `#${id + i}=IFCCARTESIANPOINT((${i}.5,${i}.25,0.));\n`).join('')
  + Array.from({ length: 20 }, (_, i) => `#${id + 60 + i * 3}=IFCPOLYLOOP((#${id + i},#${id + i + 1},#${id + i + 2}));\n`
    + `#${id + 61 + i * 3}=IFCFACEOUTERBOUND(#${id + 60 + i * 3},.T.);\n#${id + 62 + i * 3}=IFCFACE((#${id + 61 + i * 3}));\n`).join('');
const fileOf = (element: (id: number) => string, bytes: number): string => {
  let text = HEADER;
  for (let id = 100; text.length < bytes; id += 1000) text += element(id);
  return text;
};

describe('dense geometry share (#10264)', () => {
  it('counts the bytes of point-list and face-set records, not of B-rep records', () => {
    assert.ok(denseRecordBytes(fileOf(tfsElement, 200_000)).dense / denseRecordBytes(fileOf(tfsElement, 200_000)).total > 0.95);
    assert.equal(denseRecordBytes(fileOf(brepElement, 200_000)).dense, 0);
    const mixed = denseRecordBytes(tfsElement(1) + brepElement(10));
    assert.ok(mixed.dense > 0 && mixed.dense < mixed.total);
    assert.deepEqual(denseRecordBytes('(1.5,2.5),(3.5,4.5));\n'), { dense: 0, total: 0 }, 'a window inside one record names no type');
  });

  it('reads four windows of 256 KiB from a large file, never the whole file', async () => {
    const text = fileOf(tfsElement, 3 * 1024 * 1024);
    const reads: number[] = [];
    const blob = new Blob([text]);
    const spy = { size: blob.size, slice: (start?: number, end?: number) => { reads.push((end ?? blob.size) - (start ?? 0)); return blob.slice(start, end); } } as Blob;
    const share = await sampleDenseGeometryShare(spy);
    assert.ok(share !== undefined && share > 0.95, `tfs share ${share}`);
    assert.deepEqual(reads, [262144, 262144, 262144, 262144]);
    assert.ok((await sampleDenseGeometryShare(new Blob([fileOf(brepElement, 3 * 1024 * 1024)])))! < 0.01);
    assert.equal(await sampleDenseGeometryShare(new Blob(['not a step file'])), undefined);
  });
});

describe('admission estimate by geometry density (#10264)', () => {
  const MB = 1e6;
  it('refuses dense tfs-300 at a reported 4 GB, which the size-only estimate admitted and the tab died on', () => {
    assert.throws(() => inspectLocalIfcAdmission(300 * MB, 4, 1), /memory budget/);
    assert.doesNotThrow(() => inspectLocalIfcAdmission(300 * MB, 4, 0), 'B-rep content keeps the size-only rate');
    assert.doesNotThrow(() => inspectLocalIfcAdmission(300 * MB, 4), 'an unknown share keeps the size-only rate');
  });

  it('still admits dense tfs-225 at a reported 4 GB, which loaded under the 3 GiB cap', () => {
    assert.doesNotThrow(() => inspectLocalIfcAdmission(225 * MB, 4, 1));
  });

  it('keeps consent, not refusal, at the browser-capped 8 GB report for 1 GB+ files of either kind', () => {
    for (const share of [0, 1]) assert.ok(inspectLocalIfcAdmission(1.05e9, 8, share));
  });

  it('preflight samples the file and refuses a dense file that a B-rep file of the same size passes', async () => {
    const memory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 1 });
    try {
      // 1 GB reported: budget 0.75 GiB, so 30 MB passes at 8x (0.72 GiB) and fails at 10x (0.78 GiB).
      const run = async (element: (id: number) => string) => {
        const failures: unknown[] = [];
        const file = new File([fileOf(element, 30 * MB)], 'sample.ifc');
        const admission = createLocalIfcLoadAdmission(file, { isCurrent: () => true, signal: new AbortController().signal,
          onCancel: () => assert.fail('no consent dialog under 8 GB'), onFailure: (error) => failures.push(error), finish: () => {} });
        return { head: await admission.preflight(), failures };
      };
      const dense = await run(tfsElement);
      assert.equal(dense.head, null);
      assert.match(String(dense.failures[0]), /local processing memory budget/);
      const sparse = await run(brepElement);
      assert.ok(sparse.head, 'the B-rep file of the same size is admitted');
      assert.deepEqual(sparse.failures, []);
    } finally {
      if (memory) Object.defineProperty(navigator, 'deviceMemory', memory); else Reflect.deleteProperty(navigator, 'deviceMemory');
    }
  });
});
