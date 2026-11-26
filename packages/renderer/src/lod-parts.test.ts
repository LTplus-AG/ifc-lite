/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drawBatchIndices, partDraw, PartDraw, type LodPart } from './lod-parts.js';

const LOD0 = { label: 'lod0' } as unknown as GPUBuffer;
const LOD1 = { label: 'lod1' } as unknown as GPUBuffer;

function recorder() {
  const calls: string[] = [];
  const pass = {
    setIndexBuffer(buffer: GPUBuffer, format: GPUIndexFormat) { calls.push(`bind ${(buffer as unknown as { label: string }).label} ${format}`); },
    drawIndexed(count: number, instances = 1, first = 0) { calls.push(`draw ${first}+${count}${instances === 1 ? '' : ` x${instances}`}`); },
  } as unknown as GPURenderPassEncoder;
  return { calls, pass };
}

const box = (r: number): LodPart['bounds'] => ({ min: [0, 0, 0], max: [r, r, r] });
/** Three parts laid out back to back in both buffers; the middle one has no LOD1. */
const PARTS: LodPart[] = [
  { bounds: box(1), lod0Start: 0, lod0Count: 60, lod1Start: 0, lod1Count: 12 },
  { bounds: box(2), lod0Start: 60, lod0Count: 30, lod1Start: 12, lod1Count: 0 },
  { bounds: box(3), lod0Start: 90, lod0Count: 36, lod1Start: 12, lod1Count: 6 },
];
const page = { indexBuffer: LOD0, indexFormat: 'uint16' as const, lod1IndexBuffer: LOD1, indexCount: 126, lodParts: PARTS };

describe('lod-parts', () => {
  it('decides a part as the draw loop decides a bucket batch: cull, then LOD1 when it has one', () => {
    assert.equal(partDraw(PARTS[0], 2, 4, 48), PartDraw.Skip);
    assert.equal(partDraw(PARTS[0], 20, 4, 48), PartDraw.Lod1);
    assert.equal(partDraw(PARTS[1], 20, 4, 48), PartDraw.Lod0, 'no LOD1 range: full detail');
    assert.equal(partDraw(PARTS[0], 60, 4, 48), PartDraw.Lod0);
    assert.equal(partDraw(PARTS[0], 2, 0, 0), PartDraw.Lod0, 'both thresholds off');
  });

  it('draws consecutive parts that chose the same buffer with one call', () => {
    const near = recorder();
    assert.equal(drawBatchIndices(near.pass, page, false, () => PartDraw.Lod0), 2);
    assert.deepEqual(near.calls, ['bind lod0 uint16', 'draw 0+126']);

    const mixed = recorder();
    const choice = [PartDraw.Lod1, PartDraw.Lod0, PartDraw.Lod1];
    assert.equal(drawBatchIndices(mixed.pass, page, false, (part) => choice[PARTS.indexOf(part)]), 3 * 2 + 1);
    assert.deepEqual(mixed.calls, ['bind lod1 uint16', 'draw 0+12', 'bind lod0 uint16', 'draw 60+30', 'bind lod1 uint16', 'draw 12+6']);

    const far = recorder();
    assert.equal(drawBatchIndices(far.pass, page, false, (part) => (part === PARTS[1] ? PartDraw.Skip : PartDraw.Lod1)), 2 + 1);
    assert.deepEqual(far.calls, ['bind lod1 uint16', 'draw 0+18'], 'the culled middle part has no LOD1 indices between its neighbours');

    const culled = recorder();
    assert.equal(drawBatchIndices(culled.pass, page, false, () => PartDraw.Skip), 0);
    assert.deepEqual(culled.calls, []);
  });

  it('draws a batch without parts as before: its LOD1 range in u32, or every index in its own format', () => {
    const lod1 = recorder();
    assert.equal(drawBatchIndices(lod1.pass, { indexBuffer: LOD0, lod1IndexBuffer: LOD1, lod1IndexCount: 9, indexCount: 30 }, true, () => PartDraw.Skip), 3);
    assert.deepEqual(lod1.calls, ['bind lod1 uint32', 'draw 0+9']);
    const full = recorder();
    assert.equal(drawBatchIndices(full.pass, { indexBuffer: LOD0, indexFormat: 'uint16', indexCount: 30 }, false, () => PartDraw.Skip), 2);
    assert.deepEqual(full.calls, ['bind lod0 uint16', 'draw 0+30']);
  });
});
