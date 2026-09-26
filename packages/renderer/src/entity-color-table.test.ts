/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-entity colour table (#6076): the CPU image the GPU buffer holds, the
 * CPU mirrors of the WGSL lookup, and the anchor rule that turns a 24-bit
 * vertex lane back into a federated id. The render-path half (no overlay
 * geometry, draw counts, late meshes, promotion) is in
 * `renderer-render-paths.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTITY_COLOR_EMPTY_KEY,
  ENTITY_COLOR_HEADER_WORDS,
  ENTITY_LANE_ID_SPAN,
  OVERRIDE_PARAM_EMPHASIZE,
  OVERRIDE_PARAM_PAINT,
  batchHasColorOverride,
  buildEntityColorTableImage,
  entityColorSlotHash,
  entityIdAnchor,
  lookupEntityColor,
  packOverrideParams,
  resolveLaneEntityId,
} from './entity-color-table.js';
import { packEntityLane } from './scene-geometry.js';
import { MESH_UNIFORM_FLOATS, MESH_UNIFORM_OFFSET } from './mesh-rte-uniforms.js';

type Rgba = [number, number, number, number];
const RED: Rgba = [1, 0, 0, 1];
const BLUE: Rgba = [0, 0, 1, 0.5];

describe('entity colour table image (#6076)', () => {
  it('holds the override colour at the entity slot and the sentinel everywhere else', () => {
    const image = buildEntityColorTableImage(new Map<number, Rgba>([[42, RED], [7, BLUE]]));
    assert.deepEqual(lookupEntityColor(image, 42), RED);
    assert.deepEqual(lookupEntityColor(image, 7), BLUE);
    for (const other of [0, 1, 41, 43, 7 + ENTITY_LANE_ID_SPAN]) {
      assert.equal(lookupEntityColor(image, other), null, `id ${other} has no override`);
    }
    // Every slot that is not one of the two entries is the EMPTY sentinel.
    const keys = image.words.subarray(ENTITY_COLOR_HEADER_WORDS, ENTITY_COLOR_HEADER_WORDS + image.capacity);
    assert.deepEqual([...keys].filter((k) => k !== ENTITY_COLOR_EMPTY_KEY).sort((a, b) => a - b), [7, 42]);
    assert.equal(image.words[2], 2, 'header count');
  });

  it('is empty (count 0, header only) for no overrides', () => {
    const image = buildEntityColorTableImage(new Map());
    assert.equal(image.count, 0);
    assert.equal(image.words.length, ENTITY_COLOR_HEADER_WORDS);
    assert.deepEqual([...image.words], [0, 0, 0, 0]);
    assert.equal(lookupEntityColor(image, 1), null);
  });

  it('stays under 80 bytes per entry at load factor <= 1/2, with a bounded probe', () => {
    for (const n of [1, 9, 1000, 100_000]) {
      const overrides = new Map<number, Rgba>();
      for (let i = 0; i < n; i++) overrides.set(1 + i * 7919, RED);
      const image = buildEntityColorTableImage(overrides);
      assert.equal(image.count, n);
      assert.ok(image.capacity >= 2 * n, `load factor for ${n}`);
      if (n >= 8) assert.ok(image.words.byteLength < 80 * n + 16, `bytes for ${n}: ${image.words.byteLength}`);
      assert.ok(image.maxProbe < 64, `max probe for ${n}: ${image.maxProbe}`);
      for (const id of [1, 1 + (n - 1) * 7919]) assert.deepEqual(lookupEntityColor(image, id), RED);
    }
  });

  it('caps the table at the byte limit and reports what it dropped', () => {
    const overrides = new Map<number, Rgba>();
    for (let i = 0; i < 100; i++) overrides.set(i + 1, RED);
    const image = buildEntityColorTableImage(overrides, 16 + 20 * 64);
    assert.equal(image.capacity, 64);
    assert.equal(image.count, 32, 'load factor holds at the cap');
    assert.equal(image.dropped, 68);
    assert.ok(image.words.byteLength <= 16 + 20 * 64);
  });

  it('ignores ids that cannot be table keys', () => {
    const image = buildEntityColorTableImage(new Map<number, Rgba>([[-1, RED], [1.5, RED], [ENTITY_COLOR_EMPTY_KEY, RED], [3, BLUE]]));
    assert.equal(image.count, 1);
    assert.deepEqual(lookupEntityColor(image, 3), BLUE);
  });
});

describe('lane -> federated id (#6076)', () => {
  it('two models with the same express id get different colours', () => {
    // A 55-model federation puts global ids far past 2^24 (1M headroom per
    // model), so model 1's copy of express id 5 lands on the SAME 24-bit lane
    // as model 0's. The draw's anchor tells them apart.
    const model0 = 5;
    const model1 = 5 + ENTITY_LANE_ID_SPAN;
    const image = buildEntityColorTableImage(new Map<number, Rgba>([[model0, RED], [model1, BLUE]]));
    const laneOf = (id: number) => packEntityLane(id, 0xAB); // salt in the high byte, as mergeGeometry writes
    assert.equal(laneOf(model0), laneOf(model1), 'sanity: the two lanes collide');

    const anchor0 = entityIdAnchor([model0, 9, 12]);
    const anchor1 = entityIdAnchor([model1, model1 + 4]);
    assert.ok(anchor0 !== null && anchor1 !== null);
    assert.deepEqual(lookupEntityColor(image, resolveLaneEntityId(anchor0, laneOf(model0))), RED);
    assert.deepEqual(lookupEntityColor(image, resolveLaneEntityId(anchor1, laneOf(model1))), BLUE);
  });

  it('resolves every id within 2^24 of the anchor, across a 2^24 boundary', () => {
    const anchor = ENTITY_LANE_ID_SPAN - 3;
    for (const id of [anchor, anchor + 2, ENTITY_LANE_ID_SPAN, ENTITY_LANE_ID_SPAN + 1000, anchor + ENTITY_LANE_ID_SPAN - 1]) {
      assert.equal(resolveLaneEntityId(anchor, packEntityLane(id, 0xFF)), id);
    }
  });

  it('refuses an anchor when a draw spans 2^24 ids (its lanes would alias)', () => {
    assert.equal(entityIdAnchor([10, 10 + ENTITY_LANE_ID_SPAN]), null);
    assert.equal(entityIdAnchor([10, 10 + ENTITY_LANE_ID_SPAN - 1]), 10);
    assert.equal(entityIdAnchor([]), null);
  });

  it('packs overrideParams: zeros unless painting with an anchor', () => {
    const out = new Uint32Array([9, 9, 9, 9]);
    packOverrideParams(out, 77, true, false);
    assert.deepEqual([...out], [77, OVERRIDE_PARAM_PAINT, 0, 0]);
    packOverrideParams(out, 77, true, true);
    assert.deepEqual([...out], [77, OVERRIDE_PARAM_PAINT | OVERRIDE_PARAM_EMPHASIZE, 0, 0]);
    packOverrideParams(out, null, true, true);
    assert.deepEqual([...out], [0, 0, 0, 0]);
    packOverrideParams(out, 77, false, false);
    assert.deepEqual([...out], [0, 0, 0, 0]);
  });

  it('only paints a batch that holds an overridden entity, re-evaluated per generation', () => {
    const batch = { expressIds: [1, 2, 3] };
    const overrides = new Map<number, Rgba>([[2, RED]]);
    assert.equal(batchHasColorOverride(batch, overrides, 1), true);
    assert.equal(batchHasColorOverride(batch, new Map<number, Rgba>([[9, RED]]), 1), true, 'cached for generation 1');
    assert.equal(batchHasColorOverride(batch, new Map<number, Rgba>([[9, RED]]), 2), false);
    assert.equal(batchHasColorOverride(batch, null, 3), false);
  });
});

describe('entity colour table layout (#6076)', () => {
  it('uses reference fmix32 hashes and reserves the final uniform lane for override parameters', () => {
    assert.equal(entityColorSlotHash(0), 0);
    assert.equal(entityColorSlotHash(1), 0x514e28b7);
    assert.equal(MESH_UNIFORM_OFFSET.overrideParams + 4, MESH_UNIFORM_FLOATS);
  });
});
