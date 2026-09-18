/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Successor claims (issue #4955): one deleted entity replaced in place by one
 * added entity whose data AND geometry both changed. Suggestions only — every
 * test that asserts a claim also asserts that nothing was retired.
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import { buildComponentFingerprints, buildDataFingerprint } from './fingerprint.js';
import { identityMapFromSuccessors } from './identity-map.js';
import { boxIoU } from './successor-match.js';
import type { EntityAabb, EntityFingerprint, ModelDiff } from './types.js';

type Ref = number;

function box(min: [number, number, number], max: [number, number, number]): EntityAabb {
  return { min, max };
}

interface Init {
  key: string;
  aabb: EntityAabb;
  ifcType?: string;
  name?: string;
  width?: number;
  material?: string;
  container?: string;
  volume?: number;
  components?: boolean;
}

/** A wall-ish entity whose data hash follows its name/width/material, so two
 *  entities differ in data exactly when the fixture says they do. */
function entity(init: Init): EntityFingerprint<Ref> {
  const input = {
    ifcType: init.ifcType ?? 'IfcWall',
    name: init.name ?? init.key,
    propertySets: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] }],
    quantitySets: [
      { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Width', value: init.width ?? 0.2 }] },
    ],
    materials: [init.material ?? 'Concrete'],
  };
  const fingerprint: EntityFingerprint<Ref> = {
    key: init.key,
    ifcType: input.ifcType,
    dataHash: buildDataFingerprint(input),
    geometryHash: `g@${init.key}`,
    aabb: init.aabb,
    ref: 0,
  };
  if (init.components !== false) fingerprint.components = buildComponentFingerprints(input);
  if (init.container !== undefined) fingerprint.container = init.container;
  if (init.volume !== undefined) fingerprint.volume = init.volume;
  return fingerprint;
}

function run(
  base: EntityFingerprint<Ref>[],
  head: EntityFingerprint<Ref>[],
  options: Record<string, unknown> = {},
): ModelDiff<Ref> {
  return diffModels(base, head, {
    matchUnpairedByContent: true,
    detectSplitMerge: true,
    detectSuccessors: true,
    ...options,
  });
}

/** A 6 m wall, 200 mm thick, 3 m high, on the x axis, faces at y = 0 and 0.2. */
const OLD_WALL = box([0, 0, 0], [6, 0.2, 3]);

describe('boxIoU', () => {
  it('nested boxes score the volume ratio, whichever face moved', () => {
    const thickerOneFace = box([0, 0, 0], [6, 0.25, 3]);
    const thickerCentred = box([0, -0.025, 0], [6, 0.225, 3]);
    expect(boxIoU(OLD_WALL, thickerOneFace)).toBeCloseTo(0.8, 6);
    expect(boxIoU(OLD_WALL, thickerCentred)).toBeCloseTo(0.8, 6);
  });
  it('an axis shift of half the thickness scores 1/3', () => {
    expect(boxIoU(OLD_WALL, box([0, 0.1, 0], [6, 0.3, 3]))).toBeCloseTo(1 / 3, 6);
  });
  it('disjoint or degenerate boxes score 0', () => {
    expect(boxIoU(OLD_WALL, box([10, 0, 0], [16, 0.2, 3]))).toBe(0);
    expect(boxIoU(OLD_WALL, box([0, 0, 0], [0, 0, 0]))).toBe(0);
  });
});

describe('footprint successors', () => {
  it('claims a thickened, renamed, re-materialled wall as its predecessor’s footprint successor without retiring anything', () => {
    const base = [entity({ key: 'OLD', name: 'Wall-023', aabb: OLD_WALL, width: 0.2 })];
    const head = [
      entity({
        key: 'NEW',
        name: 'Wall-041',
        aabb: box([0, 0, 0], [6, 0.25, 3]),
        width: 0.25,
        material: 'Brick',
      }),
    ];
    const diff = run(base, head);

    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches).toEqual([]);
    expect(diff.splitMerges).toEqual([]);
    expect(diff.successors).toHaveLength(1);
    const claim = diff.successors![0];
    expect(claim.confidence).toBe('footprint');
    expect(claim.base.key).toBe('OLD');
    expect(claim.head.key).toBe('NEW');
    expect(claim.overlap).toBeCloseTo(0.8, 6);
    // The pset survived; the name, width and material did not.
    expect(claim.agreeingComponents).toEqual(['pset:Pset_WallCommon']);
    expect(claim.crossClass).toBeUndefined();
  });

  it('misses a 200 → 350 mm thickening (0.57 < 0.6) and an axis-shifted redraw', () => {
    const base = [entity({ key: 'OLD', aabb: OLD_WALL })];
    expect(run(base, [entity({ key: 'FAT', aabb: box([0, 0, 0], [6, 0.35, 3]) })]).successors).toEqual([]);
    expect(run(base, [entity({ key: 'SHIFTED', aabb: box([0, 0.1, 0], [6, 0.3, 3]) })]).successors).toEqual([]);
  });

  it('abstains when two new layers each cover half of the old wall', () => {
    // Each half-thickness layer nests in the old box at IoU 0.5: below the
    // threshold anyway, but also a runner-up inside the margin on the base side.
    const base = [entity({ key: 'OLD', aabb: OLD_WALL })];
    const head = [
      entity({ key: 'L1', aabb: box([0, 0, 0], [6, 0.1, 3]) }),
      entity({ key: 'L2', aabb: box([0, 0.1, 0], [6, 0.2, 3]) }),
    ];
    expect(run(base, head, { successorOverlap: 0.4 }).successors).toEqual([]);
  });

  it('yields to a merge claim when the old wall and its cladding sit under one new wall', () => {
    const base = [
      entity({ key: 'OLD', aabb: OLD_WALL }),
      entity({ key: 'CLADDING', aabb: box([0, 0.2, 0], [6, 0.24, 3]) }),
    ];
    const head = [entity({ key: 'NEW', aabb: box([0, 0, 0], [6, 0.24, 3]) })];
    // Split/merge runs first and binds all three (an `extent` merge: no
    // volumes to refute it), so the successor stage sees nothing.
    const diff = run(base, head);
    expect(diff.splitMerges!.map((c) => c.kind)).toEqual(['merge']);
    expect(diff.successors).toEqual([]);
    // Without the merge stage, OLD↔NEW is 0.833 and the cladding's 0.167 is
    // under the 0.3 runner-up ceiling: the claim names OLD, not the cladding.
    const alone = run(base, head, { detectSplitMerge: false });
    expect(alone.successors!.map((c) => [c.base.key, c.head.key])).toEqual([['OLD', 'NEW']]);
    // Cladding thick enough to reach the margin blocks the pair.
    const thick = [
      entity({ key: 'OLD', aabb: OLD_WALL }),
      entity({ key: 'CLADDING', aabb: box([0, 0.2, 0], [6, 0.35, 3]) }),
    ];
    const blocked = run(thick, [entity({ key: 'NEW', aabb: box([0, 0, 0], [6, 0.35, 3]) })], { detectSplitMerge: false });
    expect(blocked.successors).toEqual([]);
  });

  it('flags a successor of a different class within the family, but not a casing difference', () => {
    const base = [entity({ key: 'OLD', aabb: OLD_WALL })];
    const head = [entity({ key: 'NEW', ifcType: 'IfcWallStandardCase', aabb: box([0, 0, 0], [6, 0.25, 3]) })];
    expect(run(base, head).successors![0].crossClass).toBe(true);
    const upper = [entity({ key: 'NEW', ifcType: 'IFCWALL', aabb: box([0, 0, 0], [6, 0.25, 3]) })];
    expect(run(base, upper).successors![0].crossClass).toBeUndefined();
  });

  it('never pairs across families', () => {
    const base = [entity({ key: 'OLD', aabb: OLD_WALL })];
    const head = [entity({ key: 'NEW', ifcType: 'IfcCovering', aabb: box([0, 0, 0], [6, 0.25, 3]) })];
    expect(run(base, head).successors).toEqual([]);
  });

  it('is deterministic under input permutation', () => {
    const base = [
      entity({ key: 'A', aabb: box([0, 0, 0], [6, 0.2, 3]) }),
      entity({ key: 'B', aabb: box([10, 0, 0], [16, 0.2, 3]) }),
    ];
    const head = [
      entity({ key: 'B2', aabb: box([10, 0, 0], [16, 0.25, 3]) }),
      entity({ key: 'A2', aabb: box([0, 0, 0], [6, 0.25, 3]) }),
    ];
    const forward = run(base, head).successors!.map((c) => [c.base.key, c.head.key]);
    const reversed = run([...base].reverse(), [...head].reverse()).successors!.map((c) => [c.base.key, c.head.key]);
    expect(forward).toEqual([['A', 'A2'], ['B', 'B2']]);
    expect(reversed).toEqual(forward);
  });
});

describe('position successors', () => {
  const ROOM = 'Project/Building/Level 2/Room 204';
  const chair = (key: string, x: number, family: string, container?: string) =>
    entity({
      key,
      ifcType: 'IfcFurniture',
      name: family,
      aabb: box([x, 0, 0], [x + 0.5, 0.5, 0.9]),
      container,
    });

  it('pairs a family swap nudged out of its footprint, in the same room', () => {
    // 0.5 m box, so the cap is max(0.5, 0.5 × 1.14) = 0.57 m; nudged 0.4 m.
    const base = [chair('OLD', 0, 'Chair A', ROOM)];
    const head = [chair('NEW', 0.4, 'Chair B', ROOM)];
    const diff = run(base, head);
    expect(diff.successors).toHaveLength(1);
    expect(diff.successors![0]).toMatchObject({ confidence: 'position', overlap: expect.any(Number) });
    expect(diff.successors![0].distance).toBeCloseTo(0.4, 6);
  });

  it('carries the axis-shifted wall that footprint missed', () => {
    const base = [entity({ key: 'OLD', aabb: OLD_WALL, container: ROOM })];
    const head = [entity({ key: 'NEW', aabb: box([0, 0.1, 0], [6, 0.3, 3]), container: ROOM })];
    const diff = run(base, head);
    expect(diff.successors!.map((c) => c.confidence)).toEqual(['position']);
  });

  it('pairs two chairs swapped in place, each with its own', () => {
    const base = [chair('OLD-1', 0, 'Chair A', ROOM), chair('OLD-2', 2, 'Chair A', ROOM)];
    const head = [chair('NEW-1', 0.1, 'Chair B', ROOM), chair('NEW-2', 2.1, 'Chair B', ROOM)];
    const diff = run(base, head);
    expect(diff.successors!.map((c) => [c.base.key, c.head.key])).toEqual([
      ['OLD-1', 'NEW-1'],
      ['OLD-2', 'NEW-2'],
    ]);
  });

  it('abstains on a mirror-symmetric relocation', () => {
    // Two old chairs at 0 and 1; two new ones at 0.5 and 0.5 + ε: every old
    // chair's nearest new one is the same, and the runner-up is within ×2.
    const base = [chair('OLD-1', 0, 'Chair A', ROOM), chair('OLD-2', 1, 'Chair A', ROOM)];
    const head = [chair('NEW-1', 0.45, 'Chair B', ROOM), chair('NEW-2', 0.55, 'Chair B', ROOM)];
    expect(run(base, head).successors).toEqual([]);
  });

  it('abstains when the runner-up is inside the ×2 margin, and pairs at exactly ×2', () => {
    const base = [chair('OLD', 0, 'Chair A', ROOM)];
    const head = [chair('NEW-1', 0.3, 'Chair B', ROOM), chair('NEW-2', 0.5, 'Chair B', ROOM)];
    expect(run(base, head).successors).toEqual([]);
    // "At least twice as far" includes exactly twice (review on #4965).
    const boundary = [chair('NEW-1', 0.2, 'Chair B', ROOM), chair('NEW-2', 0.4, 'Chair B', ROOM)];
    expect(run(base, boundary).successors!.map((c) => c.head.key)).toEqual(['NEW-1']);
  });

  it('skips the profile when the container is absent on either side, or differs', () => {
    const base = [chair('OLD', 0, 'Chair A', ROOM)];
    expect(run(base, [chair('NEW', 0.4, 'Chair B')]).successors).toEqual([]);
    expect(run([chair('OLD', 0, 'Chair A')], [chair('NEW', 0.4, 'Chair B', ROOM)]).successors).toEqual([]);
    expect(run(base, [chair('NEW', 0.4, 'Chair B', 'Project/Building/Level 3/Room 304')]).successors).toEqual([]);
  });

  it('never pairs a small fixture sitting inside a deleted element of another size (xmatch finding F6)', () => {
    // A 6 m covering deleted; a 0.3 m same-family element added inside its
    // box in the same room. Mutual nearest, within reach, and not a
    // replacement of anything.
    const base = [entity({ key: 'COVER', ifcType: 'IfcCovering', aabb: box([0, 0, 0], [6, 0.05, 3]), container: ROOM })];
    const head = [entity({ key: 'BIT', ifcType: 'IfcCovering', aabb: box([2, 0, 1], [2.3, 0.05, 1.3]), container: ROOM })];
    expect(run(base, head).successors).toEqual([]);
    // A modest size change (a different chair family) still pairs.
    const chairs = run([chair('OLD', 0, 'Chair A', ROOM)], [
      entity({ key: 'NEW', ifcType: 'IfcFurniture', name: 'Chair B', aabb: box([0.3, 0, 0], [1.0, 0.7, 1.1]), container: ROOM }),
    ]);
    expect(chairs.successors!.map((c) => c.confidence)).toEqual(['position']);
  });

  it('respects the distance cap', () => {
    const base = [chair('OLD', 0, 'Chair A', ROOM)];
    expect(run(base, [chair('NEW', 0.8, 'Chair B', ROOM)]).successors).toEqual([]);
    expect(run(base, [chair('NEW', 0.8, 'Chair B', ROOM)], { successorDistance: 1 }).successors).toHaveLength(1);
  });
});

describe('what the stage runs on, and what it never touches', () => {
  it('never offers a split piece as the whole’s successor', () => {
    const whole = entity({ key: 'W', aabb: OLD_WALL, volume: 3.6 });
    const pieces = [0, 1, 2].map((i) =>
      entity({ key: `P${i}`, aabb: box([i * 2, 0, 0], [(i + 1) * 2, 0.2, 3]), volume: 1.2 }),
    );
    const diff = run([whole], pieces);
    expect(diff.splitMerges).toHaveLength(1);
    expect(diff.successors).toEqual([]);
  });

  it('ignores an entity without a usable box', () => {
    const base = [entity({ key: 'OLD', aabb: OLD_WALL })];
    const boxless = entity({ key: 'NEW', aabb: box([0, 0, 0], [6, 0.25, 3]) });
    delete boxless.aabb;
    expect(run(base, [boxless]).successors).toEqual([]);
  });

  it('omits agreeingComponents when a side carries no components', () => {
    const base = [entity({ key: 'OLD', aabb: OLD_WALL, components: false })];
    const head = [entity({ key: 'NEW', aabb: box([0, 0, 0], [6, 0.25, 3]) })];
    expect(run(base, head).successors![0].agreeingComponents).toBeUndefined();
  });

  it('coerces a bad overlap threshold to the default', () => {
    const base = [entity({ key: 'OLD', aabb: OLD_WALL })];
    const head = [entity({ key: 'NEW', aabb: box([0, 0, 0], [6, 0.25, 3]) })];
    expect(run(base, head, { successorOverlap: 7 }).successors).toHaveLength(1);
    expect(run(base, head, { successorOverlap: 0.9 }).successors).toEqual([]);
  });

  describe('abstentions leave the field absent', () => {
    const base = [entity({ key: 'OLD', aabb: OLD_WALL })];
    const head = [entity({ key: 'NEW', aabb: box([0, 0, 0], [6, 0.25, 3]) })];

    it("under scope 'data'", () => {
      expect(run(base, head, { scope: 'data' }).successors).toBeUndefined();
    });
    it('under a mixed-capability pair', () => {
      const bare = head.map((e) => {
        const copy = { ...e };
        delete copy.geometryHash;
        return copy;
      });
      expect(run(base, bare).successors).toBeUndefined();
    });
    it('when the option is off', () => {
      expect(run(base, head, { detectSuccessors: false }).successors).toBeUndefined();
      expect(diffModels(base, head, { detectSuccessors: true }).successors).toBeUndefined();
    });
  });
});

describe('identityMapFromSuccessors', () => {
  const base = entity({ key: 'OLD', aabb: OLD_WALL });
  const head = entity({ key: 'NEW', aabb: box([0, 0, 0], [6, 0.25, 3]) });

  it('mints an entry only from what the caller accepted, naming the profile', () => {
    const diff = run([base], [head]);
    expect(identityMapFromSuccessors(diff.successors)).toEqual([
      { base: 'OLD', here: 'NEW', reason: 'successor:footprint' },
    ]);
    expect(identityMapFromSuccessors([])).toEqual([]);
    expect(identityMapFromSuccessors(undefined)).toEqual([]);
  });

  it('yields nothing for a here claimed by two bases, and de-duplicates', () => {
    const claim = run([base], [head]).successors![0];
    const other = { ...claim, base: entity({ key: 'OTHER', aabb: OLD_WALL }) };
    expect(identityMapFromSuccessors([claim, other])).toEqual([]);
    expect(identityMapFromSuccessors([claim, claim])).toHaveLength(1);
  });
});
