/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The partial sub-batch split decision, without a Scene or a GPU. Both splits,
 * by X-Ray alpha (#4129) and by override promotion (#677), pass ONE gate: the
 * injected `canPartition` (#9220).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { PartialBatchRequests } from './partial-batch-requests.js';
import { XRayAlpha } from './xray-alpha.js';
import type { BatchedMesh } from './types.js';
import type { RGBAOverrideMap } from './overlay-routing.js';

const GLASS: [number, number, number, number] = [0.2, 0.4, 0.8, 0.4];
const SOLID: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const RED: [number, number, number, number] = [1, 0, 0, 1];

const batch = (expressIds: number[], color = GLASS): BatchedMesh =>
  ({ id: 7, colorKey: 'k', color, expressIds }) as unknown as BatchedMesh;

/** A collector whose gate answers `partitionable` and counts its calls. */
function collector(
  partitionable: boolean,
  overrides: RGBAOverrideMap | null = new Map([[1, RED]]),
  xray = new XRayAlpha({}, new Set()),
) {
  const gate = { calls: 0 };
  const requests = new PartialBatchRequests(overrides, xray, () => { gate.calls++; return partitionable; });
  const slots = () => requests.items.map((i) => i.sourceBatchKey);
  const idsOf = (slot: string) => [...requests.items.find((i) => i.sourceBatchKey === slot)!.visibleIds].sort();
  return { requests, gate, slots, idsOf };
}

describe('PartialBatchRequests: one canPartition gate for both splits (#9220)', () => {
  it('a partitionable transparent batch with mixed promotion splits into :promoted and :remaining', () => {
    const c = collector(true);
    assert.strictEqual(c.requests.pushWholeSplit(batch([1, 2]), true), true);
    assert.deepStrictEqual(c.slots(), ['k:7:promoted', 'k:7:remaining']);
    assert.deepStrictEqual(c.idsOf('k:7:promoted'), [1]);
    assert.deepStrictEqual(c.idsOf('k:7:remaining'), [2]);
  });

  it('an unpartitionable one draws whole: no request, and it still wants the split for a cold restore', () => {
    const c = collector(false);
    const b = batch([1, 2]);
    assert.strictEqual(c.requests.pushWholeSplit(b, true), false);
    assert.deepStrictEqual(c.slots(), []);
    assert.strictEqual(c.requests.wantsWholeSplit(b, true), true, 'ungated: a cold batch gets its pieces back first (#9136)');
  });

  it('hide/isolate: an unpartitionable visible subset is ONE sub-batch, a partitionable one splits', () => {
    const off = collector(false);
    off.requests.pushVisible(batch([1, 2, 3]), new Set([1, 2]), true);
    assert.deepStrictEqual(off.slots(), ['k:7']);
    assert.deepStrictEqual(off.idsOf('k:7'), [1, 2]);
    const on = collector(true);
    on.requests.pushVisible(batch([1, 2, 3]), new Set([1, 2]), true);
    assert.deepStrictEqual(on.slots(), ['k:7:promoted', 'k:7:remaining']);
  });

  it('the gate is not consulted when no promotion split is wanted', () => {
    for (const [ids, transparent, color] of [
      [[1, 2], false, SOLID], // opaque
      [[1], true, GLASS], // every id promoted
      [[2, 3], true, GLASS], // none promoted
    ] as const) {
      const c = collector(true);
      assert.strictEqual(c.requests.pushWholeSplit(batch([...ids], color), transparent), false);
      c.requests.pushVisible(batch([...ids], color), new Set(ids), transparent);
      assert.deepStrictEqual(c.slots(), ['k:7'], 'one plain sub-batch from pushVisible');
      assert.strictEqual(c.gate.calls, 0, `ids ${ids.join(',')}`);
    }
  });

  it('X-Ray alpha then promotion: the gate runs once, and each transparent group splits under its :xN slot', () => {
    const xray = new XRayAlpha({ transparencyOverrides: new Map([[3, 0.18]]) }, new Set());
    const c = collector(true, new Map([[1, RED]]), xray);
    assert.strictEqual(c.requests.pushWholeSplit(batch([1, 2, 3]), true), true);
    assert.strictEqual(c.gate.calls, 1);
    const slots = c.slots().sort();
    assert.strictEqual(slots.length, 3);
    assert.ok(slots.some((s) => /^k:7:x\d+:promoted$/.test(s)) && slots.some((s) => /^k:7:x\d+:remaining$/.test(s)), slots.join(' '));
    assert.ok(slots.some((s) => /^k:7:x\d+$/.test(s)), 'the faded group alone, unsplit');
  });

  it('X-Ray on an unpartitionable batch: neither split, drawn whole', () => {
    const xray = new XRayAlpha({ transparencyOverrides: new Map([[3, 0.18]]) }, new Set());
    const c = collector(false, new Map([[1, RED]]), xray);
    assert.strictEqual(c.requests.pushWholeSplit(batch([1, 2, 3]), true), false);
    assert.deepStrictEqual(c.slots(), []);
  });
});
