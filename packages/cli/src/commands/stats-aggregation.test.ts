/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite stats` (KPI / WWR / GFA aggregation) had zero tests. Its
 * quantity-summing, WWR and GFA logic was extracted into
 * `stats-aggregation.ts` so it can be exercised against a fake `bim`
 * surface instead of only through a real parsed IFC file.
 *
 * Every fixture below uses at least three items with distinct values, an
 * empty group, and a mix of group sizes — a single-item or all-identical
 * fixture cannot distinguish `sum` from `max` from "read the first item",
 * and would let several real mutants below through silently.
 */

import { describe, expect, it } from 'vitest';
import {
  sumQuantity,
  getPropertyValue,
  isTruthyIfcBoolean,
  aggregateWalls,
  computeWindowWallRatio,
  computeGrossFloorArea,
  computeMaterialSummary,
  computeStoreyNames,
  computeBuildingName,
  computeValidation,
  type QuantitySet,
  type PropertySet,
} from './stats-aggregation.js';

function fakeBim(
  quantities: Record<number, QuantitySet[]> = {},
  properties: Record<number, PropertySet[]> = {},
  materials: Record<number, { materials?: Array<string | { name?: string }>; name?: string } | null> = {},
) {
  return {
    quantities: (ref: number) => quantities[ref] ?? [],
    properties: (ref: number) => properties[ref] ?? [],
    materials: (ref: number) => materials[ref] ?? null,
  };
}

describe('sumQuantity', () => {
  it('sums a named quantity across distinct-valued refs, ignoring unrelated names', () => {
    const bim = fakeBim({
      1: [{ name: 'Qto_SlabBaseQuantities', quantities: [{ name: 'GrossArea', value: 10 }] }],
      2: [{ name: 'Qto_SlabBaseQuantities', quantities: [{ name: 'GrossArea', value: 25 }] }],
      3: [{ name: 'Qto_SlabBaseQuantities', quantities: [{ name: 'NetArea', value: 4 }] }],
    });
    // 10 + 25 + 4 = 39 — a `max` mutant would answer 25, a "first element"
    // mutant would answer 10; only a real sum lands on 39.
    expect(sumQuantity(bim, [1, 2, 3], ['GrossArea', 'NetArea'])).toBe(39);
  });

  it('treats an empty ref list as an empty group — 0, not undefined/NaN', () => {
    const bim = fakeBim({});
    expect(sumQuantity(bim, [], ['GrossArea'])).toBe(0);
  });

  it('coerces an unparseable quantity value to 0 instead of poisoning the sum with NaN', () => {
    const bim = fakeBim({
      1: [{ name: 'Q', quantities: [{ name: 'GrossArea', value: 'not-a-number' }] }],
      2: [{ name: 'Q', quantities: [{ name: 'GrossArea', value: 5 }] }],
    });
    const total = sumQuantity(bim, [1, 2], ['GrossArea']);
    expect(total).toBe(5);
    expect(Number.isNaN(total)).toBe(false);
  });

  it('sums every match within a single quantity set, not just the first', () => {
    // Two same-named quantities in one qset is not valid IFC (IfcElementQuantity's
    // UniqueQuantityNames WHERE rule forbids it), but sumQuantity does not guess
    // intent for non-compliant data — it sums whatever is present: 2 + 3 = 5.
    const bim = fakeBim({
      1: [{ name: 'Qto_WindowBaseQuantities', quantities: [{ name: 'Area', value: 2 }, { name: 'Area', value: 3 }] }],
    });
    expect(sumQuantity(bim, [1], ['Area'])).toBe(5);
  });
});

describe('getPropertyValue', () => {
  it('finds a property inside the named pset, ignoring other psets', () => {
    const bim = fakeBim({}, {
      1: [
        { name: 'Pset_Other', properties: [{ name: 'IsExternal', value: true }] },
        { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: false }] },
      ],
    });
    expect(getPropertyValue(bim, 1, 'Pset_WallCommon', 'IsExternal')).toBe(false);
  });

  it('returns undefined when the pset or property is absent', () => {
    const bim = fakeBim({}, { 1: [{ name: 'Pset_WallCommon', properties: [] }] });
    expect(getPropertyValue(bim, 1, 'Pset_WallCommon', 'IsExternal')).toBeUndefined();
    expect(getPropertyValue(bim, 99, 'Pset_WallCommon', 'IsExternal')).toBeUndefined();
  });

  it('finds a property on a SECOND same-named pset when the first same-named pset lacks it', () => {
    // Two distinct IfcPropertySets named "Pset_WallCommon" on one entity is
    // legitimate IFC (e.g. one via the type definition, one via the
    // occurrence) -- a lookup that only checked the first same-named pset
    // would wrongly report FireRating missing here.
    const bim = fakeBim({}, {
      1: [
        { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
        { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI60' }] },
      ],
    });
    expect(getPropertyValue(bim, 1, 'Pset_WallCommon', 'FireRating')).toBe('REI60');
  });
});

describe('isTruthyIfcBoolean', () => {
  it('accepts the boolean and STEP-encoded true forms', () => {
    expect(isTruthyIfcBoolean(true)).toBe(true);
    expect(isTruthyIfcBoolean('TRUE')).toBe(true);
    expect(isTruthyIfcBoolean('.T.')).toBe(true);
  });

  it('rejects false, falsy STEP encodings, and near-miss strings', () => {
    expect(isTruthyIfcBoolean(false)).toBe(false);
    expect(isTruthyIfcBoolean('.F.')).toBe(false);
    expect(isTruthyIfcBoolean('FALSE')).toBe(false);
    expect(isTruthyIfcBoolean('true')).toBe(false); // lowercase is not a valid STEP encoding
    expect(isTruthyIfcBoolean(undefined)).toBe(false);
  });
});

describe('aggregateWalls', () => {
  // Three walls with distinct areas/volumes; two external (different areas,
  // so a wrong external-subset sum would be caught), one internal, one wall
  // with a property set that doesn't say IsExternal at all.
  const bim = fakeBim(
    {
      1: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'GrossSideArea', value: 10 }, { name: 'GrossVolume', value: 2 }] }],
      2: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'GrossSideArea', value: 30 }, { name: 'GrossVolume', value: 6 }] }],
      3: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetSideArea', value: 5 }, { name: 'NetVolume', value: 1 }] }],
    },
    {
      1: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] }],
      2: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: false }] }],
      3: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsFireRated', value: true }] }], // no IsExternal at all
    },
  );
  const walls = [{ ref: 1 }, { ref: 2 }, { ref: 3 }];

  it('sums total wall area and volume over every wall', () => {
    const { totalWallArea, totalWallVolume } = aggregateWalls(bim, walls);
    expect(totalWallArea).toBe(45); // 10 + 30 + 5
    expect(totalWallVolume).toBe(9); // 2 + 6 + 1
  });

  it('exteriorWallArea is the subset from IsExternal=true walls only, not the whole total', () => {
    const { exteriorWallArea, totalWallArea } = aggregateWalls(bim, walls);
    expect(exteriorWallArea).toBe(10); // wall 1 only
    expect(exteriorWallArea).not.toBe(totalWallArea); // guards against a copy-total mutant
  });

  it('a wall missing IsExternal entirely is excluded, same as an explicit false', () => {
    // Wall 3 has no IsExternal property at all. If a mutant treated
    // "property absent" as external (e.g. `!== false` instead of `=== true`),
    // exteriorWallArea would pick up wall 3's area of 5.
    const { exteriorWallArea } = aggregateWalls(bim, walls);
    expect(exteriorWallArea).toBe(10);
  });
});

describe('computeWindowWallRatio', () => {
  it('divides by exterior wall area when it is present (not total wall area)', () => {
    // window 20 / exterior 40 = 50%. If the denominator were mistakenly the
    // total wall area (100), the answer would be 20% instead.
    expect(computeWindowWallRatio(20, 40, 100)).toBe(50);
  });

  it('falls back to total wall area only when exterior area is exactly 0', () => {
    expect(computeWindowWallRatio(20, 0, 40)).toBe(50);
  });

  it('is 0, not NaN or Infinity, when both areas are 0', () => {
    expect(computeWindowWallRatio(0, 0, 0)).toBe(0);
  });

  it('is a ratio, not a difference — swapping to subtraction would still pass a same-scale check', () => {
    // window(10)/wall(20) = 50, guards against an operand-swap mutant that
    // divides wall/window and would give 200 here.
    expect(computeWindowWallRatio(10, 20, 20)).toBe(50);
  });
});

describe('computeGrossFloorArea', () => {
  it('sums GrossFloorArea across storeys of different group sizes, including a storey with none', () => {
    const bim = fakeBim({
      1: [{ name: 'Qto_BuildingStoreyBaseQuantities', quantities: [{ name: 'GrossFloorArea', value: 100 }] }],
      2: [{ name: 'Qto_BuildingStoreyBaseQuantities', quantities: [{ name: 'GrossFloorArea', value: 250 }] }],
      // storey 3 has no quantities at all — an empty group that must
      // contribute 0, not be skipped in a way that breaks the running sum.
    });
    const storeys = [{ ref: 1 }, { ref: 2 }, { ref: 3 }];
    // 100 + 250 + 0 = 350. A `max`-shaped mutant would answer 250; a
    // first-storey-only mutant would answer 100.
    expect(computeGrossFloorArea(bim, storeys, /* fallback */ 999)).toBe(350);
  });

  it('falls back to total slab floor area only when the storey sum is exactly 0', () => {
    const bim = fakeBim({});
    const storeys = [{ ref: 1 }, { ref: 2 }];
    expect(computeGrossFloorArea(bim, storeys, 77)).toBe(77);
  });

  it('does not fall back when the storey sum is genuinely positive', () => {
    const bim = fakeBim({
      1: [{ name: 'Q', quantities: [{ name: 'GrossFloorArea', value: 12 }] }],
    });
    expect(computeGrossFloorArea(bim, [{ ref: 1 }], /* fallback */ 999)).toBe(12);
  });
});

describe('computeMaterialSummary', () => {
  it('sorts by element count descending across materials with distinct counts', () => {
    const bim = fakeBim(
      {
        1: [{ name: 'Q', quantities: [{ name: 'GrossVolume', value: 1 }] }],
        2: [{ name: 'Q', quantities: [{ name: 'GrossVolume', value: 2 }] }],
        3: [{ name: 'Q', quantities: [{ name: 'GrossVolume', value: 4 }] }],
        4: [{ name: 'Q', quantities: [{ name: 'GrossVolume', value: 8 }] }],
      },
      {},
      {
        1: { name: 'Concrete' },
        2: { name: 'Concrete' },
        3: { name: 'Concrete' },
        4: { name: 'Steel' },
      },
    );
    const elements = [{ ref: 1 }, { ref: 2 }, { ref: 3 }, { ref: 4 }];
    const round = (n: number) => n;
    const summary = computeMaterialSummary(bim, elements, round);

    expect(summary.map(m => m.name)).toEqual(['Concrete', 'Steel']); // 3 elements before 1
    expect(summary[0]).toMatchObject({ name: 'Concrete', count: 3, volume: 7 }); // 1+2+4
    expect(summary[1]).toMatchObject({ name: 'Steel', count: 1, volume: 8 });
  });

  it('elements with no material are skipped, not counted under an empty-string key', () => {
    const bim = fakeBim({}, {}, { 1: null, 2: { name: 'Wood' } });
    const summary = computeMaterialSummary(bim, [{ ref: 1 }, { ref: 2 }], n => n);
    expect(summary).toEqual([{ name: 'Wood', count: 1, volume: 0 }]);
  });

  /**
   * Regression: `firstName ?? mat?.name` followed by `if (!matName)
   * continue;` skips a plain empty-string name (falsy) but a
   * whitespace-only name (`IFCMATERIAL('   ',$,$)`) is truthy and used
   * verbatim as the Map key — a blank-looking row in the material
   * schedule instead of being skipped like a genuinely absent material.
   */
  it('a whitespace-only material name is skipped, not counted under a whitespace key', () => {
    const bim = fakeBim({}, {}, { 1: { name: '   ' }, 2: { name: 'Wood' } });
    const summary = computeMaterialSummary(bim, [{ ref: 1 }, { ref: 2 }], n => n);
    expect(summary).toEqual([{ name: 'Wood', count: 1, volume: 0 }]);
  });
});

describe('computeStoreyNames', () => {
  /**
   * Regression: `storeys.map(s => s.name).filter(Boolean)` drops a plain
   * empty-string Name (falsy) but keeps a whitespace-only one
   * (`IFCBUILDINGSTOREY('...','   ',...)`, truthy) as a blank-looking
   * entry in the storey list.
   */
  it('drops blank and whitespace-only storey names, keeps genuine ones', () => {
    expect(computeStoreyNames([{ name: '' }, { name: '   ' }, { name: 'Level 1' }])).toEqual(['Level 1']);
  });

  it('returns an empty array when every storey is unnamed (control)', () => {
    expect(computeStoreyNames([{ name: '' }, { name: undefined }])).toEqual([]);
  });
});

describe('computeBuildingName', () => {
  /**
   * Regression: `buildings[0]?.name ?? '(unnamed)'` only falls through on
   * null/undefined; a present-but-blank/whitespace-only `IfcBuilding.Name`
   * was returned verbatim instead of the "(unnamed)" placeholder.
   */
  it('falls a blank building Name through to "(unnamed)"', () => {
    expect(computeBuildingName([{ name: '' }])).toBe('(unnamed)');
  });

  it('falls a whitespace-only building Name through to "(unnamed)"', () => {
    expect(computeBuildingName([{ name: '   ' }])).toBe('(unnamed)');
  });

  it('returns a genuine building Name unchanged (control)', () => {
    expect(computeBuildingName([{ name: 'Main Building' }])).toBe('Main Building');
  });

  it('returns "(unnamed)" when there is no building at all (control)', () => {
    expect(computeBuildingName([])).toBe('(unnamed)');
  });
});

describe('computeValidation', () => {
  it('counts offending GlobalIds once each, not once per duplicate row', () => {
    const elements = [
      { globalId: 'A', name: 'Wall 1' },
      { globalId: 'A', name: 'Wall 2' }, // duplicates A
      { globalId: 'A', name: 'Wall 3' }, // triples A — still 1 offending id
      { globalId: 'B', name: 'Wall 4' },
      { globalId: 'C', name: '' }, // unique id, unnamed
    ];
    const result = computeValidation(elements);
    expect(result.duplicateGlobalIds).toBe(1); // one offending id (A), not 2 (extra duplicate rows)
    expect(result.unnamedElements).toBe(1);
  });

  it('treats a missing globalId as absent, not as a shared duplicate key', () => {
    const elements = [{ name: 'X' }, { name: 'Y' }, { name: 'Z' }];
    const result = computeValidation(elements);
    expect(result.duplicateGlobalIds).toBe(0);
    expect(result.unnamedElements).toBe(0);
  });
});
