/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/plugin-api` is dependency-free by contract, so `SourceFingerprint`
 * and `IdentityEntryLike` are RESTATEMENTS of `@ifc-lite/diff`'s
 * `EntityFingerprint` and `IdentityMapEntry` rather than re-exports. Nothing
 * in the type system stops the two from drifting.
 *
 * This file is what stops it: it converts in both directions with a spread
 * and nothing else, which is exactly what a host does when it feeds a
 * provider's fingerprints to the real engine. A field renamed on either side
 * fails here, at the seam, instead of in a viewer that silently reports every
 * element as changed.
 *
 * `@ifc-lite/diff` is a DEV dependency: the fixture derives its own diffs
 * (`commit-derive.ts`) precisely so a conformance oracle never needs the
 * engine — or the wasm runtime behind the geometry hashes it consumes.
 */

import { describe, expectTypeOf, expect, it } from 'vitest';
import type { EntityFingerprint, IdentityMapEntry } from '@ifc-lite/diff';
import type { IdentityEntryLike, SourceFingerprint } from '@ifc-lite/plugin-api';

describe('plugin-api commit shapes against @ifc-lite/diff', () => {
  it('a SourceFingerprint is an EntityFingerprint once a ref is attached', () => {
    const source: SourceFingerprint = {
      key: 'wall-a',
      ifcType: 'IfcWall',
      dataHash: 'd1',
      geometryHash: 'deadbeef',
      aabb: { min: [0, 0, 0], max: [1, 2, 3] },
      volume: 6,
      components: { 'attr:core': 'd1' },
      container: 'storey-1',
    };
    const engine: EntityFingerprint<{ modelId: string }> = { ...source, ref: { modelId: 'm1' } };

    expect(engine.key).toBe(source.key);
    expect(engine.geometryHash).toBe('deadbeef');
    // `geometryHash` is `bigint | string` in the engine and `string` here —
    // the narrowing is deliberate (these cross JSON) and must stay ASSIGNABLE.
    expectTypeOf<SourceFingerprint['geometryHash']>().toExtend<EntityFingerprint['geometryHash']>();
    expectTypeOf<SourceFingerprint['aabb']>().toExtend<EntityFingerprint['aabb']>();
  });

  it('an IdentityEntryLike is an IdentityMapEntry', () => {
    const record: IdentityEntryLike = { base: 'a', here: 'b', reason: 'content-match:renamed' };
    const entry: IdentityMapEntry = { ...record };
    expect(entry).toEqual(record);
    expectTypeOf<IdentityEntryLike>().toExtend<IdentityMapEntry>();
  });
});
