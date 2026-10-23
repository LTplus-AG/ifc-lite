/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { EntityFingerprint } from './types.js';

/** Column contract shared with rust/diff/src/columns.rs; refs stay in JS. */
export function fingerprintColumns<TRef>(entities: readonly EntityFingerprint<TRef>[]) {
  const strings: string[] = [];
  const dictionary = new Map<string, number>();
  const intern = (value: string): number => {
    const existing = dictionary.get(value);
    if (existing !== undefined) return existing;
    // Rust strings contain Unicode scalars. Refuse a lossy projection until
    // lossless entity-key transport lands with the public facade (#8042).
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (next >= 0xdc00 && next <= 0xdfff) continue;
      } else if (code < 0xdc00 || code > 0xdfff) continue;
      throw new Error('WASM diff columns require well-formed UTF-16; use the public TypeScript diffModels API for this input (#8042).');
    }
    const index = strings.length;
    strings.push(value);
    dictionary.set(value, index);
    return index;
  };
  const absent = 0xffff_ffff;
  const fields = new Uint32Array(entities.length * 5);
  const flags = new Uint8Array(entities.length);
  const boxes = new Float64Array(entities.length * 6);
  const volumes = new Float64Array(entities.length);
  const componentOffsets = new Uint32Array(entities.length + 1);
  const pairs: number[] = [];
  for (let row = 0; row < entities.length; row++) {
    const entity = entities[row];
    fields[row * 5] = intern(entity.key);
    fields[row * 5 + 1] = intern(entity.ifcType);
    fields[row * 5 + 2] = intern(entity.dataHash);
    fields[row * 5 + 3] = entity.geometryHash === undefined ? absent : intern(String(entity.geometryHash));
    fields[row * 5 + 4] = entity.container === undefined ? absent : intern(entity.container);
    if (entity.aabb !== undefined) {
      flags[row] |= 1;
      boxes.set(entity.aabb.min, row * 6);
      boxes.set(entity.aabb.max, row * 6 + 3);
    }
    if (entity.volume !== undefined) {
      flags[row] |= 2;
      volumes[row] = entity.volume;
    }
    if (entity.components !== undefined) {
      flags[row] |= 4;
      for (const [key, value] of Object.entries(entity.components)) {
        pairs.push(intern(key), intern(value));
      }
    }
    componentOffsets[row + 1] = pairs.length / 2;
  }
  return { strings, fields, flags, boxes, volumes, componentOffsets, componentPairs: new Uint32Array(pairs) };
}
