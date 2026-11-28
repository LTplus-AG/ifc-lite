/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { decodeInstancedShard } from './packed-instanced-decoder.js';
import { encodeInstancedShard, type InstancedShardTemplateInput } from './packed-instanced-encoder.js';

const tri = (dx = 0): InstancedShardTemplateInput => ({
  positions: new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  origin: [10.5, -2.25, 1e6 + 0.125],
});
const translate = (x: number, y: number, z: number) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];

describe('encodeInstancedShard', () => {
  it('round-trips a base-record shard as version 1', () => {
    const bytes = encodeInstancedShard([tri(), tri(5)], [
      { templateIndex: 0, entityId: 7, color: [1, 0, 0, 1], transform: translate(1, 2, 3) },
      { templateIndex: 1, entityId: 8, color: [0, 1, 0, 0.5], transform: translate(4, 5, 6) },
      { templateIndex: 0, entityId: 9, color: [0, 0, 1, 1], transform: translate(7, 8, 9) },
    ]);
    expect(new Uint32Array(bytes, 0, 8)[1]).toBe(1);
    const shard = decodeInstancedShard(bytes);
    expect(shard.carriesItemIds).toBe(false);
    expect(shard.carriesFinishes).toBe(false);
    expect(shard.templateKeys).toBeUndefined();
    expect(shard.templates).toHaveLength(2);
    expect(Array.from(shard.templates[1].positions)).toEqual(Array.from(tri(5).positions));
    expect(Array.from(shard.templates[1].indices)).toEqual([0, 1, 2]);
    expect(shard.templates[0].origin).toEqual([10.5, -2.25, 1e6 + 0.125]);
    expect(shard.instances.map((i) => [i.templateIndex, i.entityId])).toEqual([[0, 7], [1, 8], [0, 9]]);
    expect(shard.instances[1].color).toEqual([0, 1, 0, 0.5]);
    expect(Array.from(shard.instances[2].transform)).toEqual(translate(7, 8, 9));
  });

  it('writes item ids as version 2 and finishes as version 3, unauthored values staying absent', () => {
    const v2 = decodeInstancedShard(encodeInstancedShard([tri()], [
      { templateIndex: 0, entityId: 1, color: [1, 1, 1, 1], transform: translate(0, 0, 0), itemId: 42 },
      { templateIndex: 0, entityId: 2, color: [1, 1, 1, 1], transform: translate(0, 0, 0) },
    ]));
    expect(v2.carriesItemIds).toBe(true);
    expect(v2.carriesFinishes).toBe(false);
    expect(v2.instances.map((i) => i.itemId)).toEqual([42, undefined]);

    const v3bytes = encodeInstancedShard([tri()], [
      { templateIndex: 0, entityId: 1, color: [1, 1, 1, 1], transform: translate(0, 0, 0), roughness: 0 },
      { templateIndex: 0, entityId: 2, color: [1, 1, 1, 1], transform: translate(0, 0, 0), metallic: 0.5, itemId: 3 },
    ]);
    expect(new Uint32Array(v3bytes, 0, 8)[1]).toBe(3);
    const v3 = decodeInstancedShard(v3bytes);
    expect(v3.carriesFinishes).toBe(true);
    expect(v3.instances.map((i) => [i.metallic, i.roughness, i.itemId])).toEqual([[undefined, 0, undefined], [0.5, undefined, 3]]);
  });

  it('appends the template-key trailer only when a template is keyed', () => {
    const keyed = decodeInstancedShard(encodeInstancedShard([{ ...tri(), key: [3, 9] }, tri()], [
      { templateIndex: 1, entityId: 1, color: [1, 1, 1, 1], transform: translate(0, 0, 0) },
    ]));
    expect(keyed.templateKeys).toEqual(['3:9', '']);
  });

  it('refuses an instance naming a template the shard does not hold', () => {
    expect(() => encodeInstancedShard([tri()], [
      { templateIndex: 1, entityId: 1, color: [1, 1, 1, 1], transform: translate(0, 0, 0) },
    ])).toThrow(/names template 1/);
  });
});
