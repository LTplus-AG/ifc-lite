/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Seeded-GUID determinism for the in-store builders: with a seeded
 * `RandomSource` on the anchor (or duplicate options), two identical build
 * runs must emit identical GlobalIds; without one, the platform CSPRNG
 * path stays random. Counterpart of the `IfcCreator` Timestamp/GuidSource
 * tests in ../ifc-creator.test.ts for the anchored builder path.
 */

import { describe, expect, it } from 'vitest';
import { isValidIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import { addWallToStore } from './wall.js';
import { addSlabToStore } from './slab.js';
import { addDoorToStore } from './door.js';
import { addSpaceToStore } from './space.js';
import { duplicateInStore, type SourceAttributes } from './duplicate.js';

/** mulberry32 - deterministic `RandomSource` for the tests. */
function seeded(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

function anchorWith(random: RandomSource | undefined): SpatialAnchor {
  return {
    ownerHistoryId: 5,
    bodyContextId: 14,
    axisContextId: 15,
    storeyId: 43,
    storeyPlacementId: 54,
    guidRandom: random,
  };
}

/** Build one wall + slab + door + space and collect every emitted GlobalId, in order. */
function buildRun(random: RandomSource | undefined): string[] {
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(makeStore(60), view);
  const anchor = anchorWith(random);
  addWallToStore(editor, anchor, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
  addSlabToStore(editor, anchor, { Profile: 'rectangle', Position: [0, 0, 0], Width: 5, Depth: 4, Thickness: 0.25 });
  addDoorToStore(editor, anchor, { Position: [1, 0, 0], Width: 0.9, Height: 2.1 });
  addSpaceToStore(editor, anchor, {
    Profile: 'rectangle', Position: [0, 0, 0], Width: 4, Depth: 3, Height: 2.8,
    boundaries: [{ elementId: 43 }],
  });
  return view.getNewEntities()
    .filter((e) => typeof e.attributes[0] === 'string' && isValidIfcGuid(e.attributes[0] as string))
    .map((e) => e.attributes[0] as string);
}

describe('in-store builders with a seeded RandomSource', () => {
  it('two same-seed runs emit identical GlobalIds through every builder', () => {
    const a = buildRun(seeded(42));
    const b = buildRun(seeded(42));
    expect(a.length).toBeGreaterThanOrEqual(8); // 4 elements + their rels + space boundary
    expect(b).toEqual(a);
  });

  it('different seeds diverge', () => {
    const a = buildRun(seeded(42));
    const b = buildRun(seeded(43));
    expect(b).not.toEqual(a);
  });

  it('unseeded runs stay random (CSPRNG default path)', () => {
    const a = buildRun(undefined);
    const b = buildRun(undefined);
    expect(a.length).toBe(b.length);
    expect(b).not.toEqual(a);
  });

  it('duplicateInStore honours options.guidRandom', () => {
    const source: SourceAttributes = {
      type: 'IfcWall',
      attributes: ['2AbCdEfGhIjKlMnOpQrStU', '#5', 'Wall', null, null, '#7', '#8', null],
      placementExpressId: 7,
      parentPlacementId: null,
      sourceLocation: [0, 0, 0],
      representationId: 8,
      ownerHistoryId: 5,
      axisRef: null,
      refDirectionRef: null,
      storeyId: 43,
    };
    const run = (random?: RandomSource): string[] => {
      const view = new MutablePropertyView(null, 'm1');
      const editor = new StoreEditor(makeStore(60), view);
      duplicateInStore(editor, source, { guidRandom: random });
      return view.getNewEntities()
        .filter((e) => typeof e.attributes[0] === 'string' && isValidIfcGuid(e.attributes[0] as string))
        .map((e) => e.attributes[0] as string);
    };
    const a = run(seeded(7));
    const b = run(seeded(7));
    expect(a.length).toBeGreaterThanOrEqual(2); // duplicate root + containment rel
    expect(b).toEqual(a);
    expect(run(seeded(8))).not.toEqual(a);
  });
});
