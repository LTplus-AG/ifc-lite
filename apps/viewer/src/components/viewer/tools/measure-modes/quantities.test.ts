/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  classifyBasis,
  pickElementQuantities,
  rollupQuantities,
  rollupGeometryVolumes,
  rollupMeshArea,
  MEASURABLE_QUANTITY_TYPES,
  type QuantitySetLike,
} from './quantities.js';

const { Length, Area, Volume, Weight } = MEASURABLE_QUANTITY_TYPES;
/** QuantityType.Count — deliberately not a measurement this tool reports. */
const COUNT = 3;
/** QuantityType.Time — likewise. */
const TIME = 5;

const qset = (
  name: string,
  quantities: Array<{ name: string; type: number; value: number }>,
): QuantitySetLike => ({ name, quantities });

describe('classifyBasis', () => {
  it('reads the openings-included/excluded distinction off the name prefix', () => {
    assert.deepStrictEqual(classifyBasis('NetVolume'), { basis: 'net', stem: 'volume' });
    assert.deepStrictEqual(classifyBasis('GrossVolume'), { basis: 'gross', stem: 'volume' });
  });

  it('does NOT guess a basis for an unqualified name', () => {
    // Labelling a bare `Volume` as net would put a confidence on it the file
    // never expressed — this is the claim the whole gross/net readout rests on.
    assert.deepStrictEqual(classifyBasis('Volume'), { basis: 'unqualified', stem: 'volume' });
  });

  it('is case-insensitive on both the prefix and the stem', () => {
    assert.deepStrictEqual(classifyBasis('NETSIDEAREA'), { basis: 'net', stem: 'sidearea' });
    assert.deepStrictEqual(classifyBasis('grossArea'), { basis: 'gross', stem: 'area' });
  });
});

describe('pickElementQuantities', () => {
  it('classifies by QuantityType, not by the name', () => {
    // A quantity called "Length" typed as a Volume is a Volume. Relying on the
    // name would file it under Length and then add it to a metre total.
    const picked = pickElementQuantities([
      qset('Qto_Odd', [{ name: 'Length', type: Volume, value: 7 }]),
    ]);
    assert.strictEqual(picked.length, 1);
    assert.strictEqual(picked[0].quantityType, Volume);
  });

  it('keeps net and gross as separate answers', () => {
    const picked = pickElementQuantities([
      qset('Qto_WallBaseQuantities', [
        { name: 'NetVolume', type: Volume, value: 3 },
        { name: 'GrossVolume', type: Volume, value: 4 },
      ]),
    ]);
    assert.deepStrictEqual(
      picked.map((p) => [p.basis, p.value]),
      [['net', 3], ['gross', 4]],
    );
  });

  it('takes ONE area per basis instead of summing an element\'s several areas', () => {
    // This is the defect the bucket exists to prevent: a wall declares a side
    // area, a footprint area and a cross-section area, and adding them reports
    // an area the wall does not have. 5.5 + 2 + 0.3 = 7.8 must NOT appear.
    const picked = pickElementQuantities([
      qset('Qto_WallBaseQuantities', [
        { name: 'NetSideArea', type: Area, value: 5.5 },
        { name: 'NetFootprintArea', type: Area, value: 2 },
        { name: 'CrossSectionArea', type: Area, value: 0.3 },
      ]),
    ]);
    const netAreas = picked.filter((p) => p.quantityType === Area && p.basis === 'net');
    assert.strictEqual(netAreas.length, 1);
    assert.strictEqual(netAreas[0].value, 5.5);
  });

  it('prefers the more representative name when several compete in one bucket', () => {
    // `NetArea` outranks `NetFootprintArea`, whatever order they arrive in.
    const forward = pickElementQuantities([
      qset('Qto_X', [
        { name: 'NetFootprintArea', type: Area, value: 2 },
        { name: 'NetArea', type: Area, value: 9 },
      ]),
    ]);
    const reversed = pickElementQuantities([
      qset('Qto_X', [
        { name: 'NetArea', type: Area, value: 9 },
        { name: 'NetFootprintArea', type: Area, value: 2 },
      ]),
    ]);
    assert.strictEqual(forward[0].value, 9);
    assert.strictEqual(reversed[0].value, 9);
  });

  it('keeps the first of two equally unranked names, so the pick is stable', () => {
    const picked = pickElementQuantities([
      qset('Qto_X', [
        { name: 'NetWeirdArea', type: Area, value: 1 },
        { name: 'NetOtherArea', type: Area, value: 2 },
      ]),
    ]);
    assert.strictEqual(picked.length, 1);
    assert.strictEqual(picked[0].value, 1);
  });

  it('records which quantity actually won', () => {
    const picked = pickElementQuantities([
      qset('Qto_WallBaseQuantities', [{ name: 'NetSideArea', type: Area, value: 5.5 }]),
    ]);
    assert.strictEqual(picked[0].provenance, 'Qto_WallBaseQuantities.NetSideArea');
  });

  it('ignores Count and Time', () => {
    // Totalling a door count beside a volume would invite reading one as the
    // other; neither is a measurement of the building's geometry.
    const picked = pickElementQuantities([
      qset('Qto_X', [
        { name: 'NumberOfRisers', type: COUNT, value: 17 },
        { name: 'Duration', type: TIME, value: 3600 },
        { name: 'NetVolume', type: Volume, value: 1 },
      ]),
    ]);
    assert.deepStrictEqual(picked.map((p) => p.quantityType), [Volume]);
  });

  it('drops non-finite values instead of carrying them into a sum', () => {
    // One NaN poisons the total for every other element in the selection.
    const picked = pickElementQuantities([
      qset('Qto_X', [
        { name: 'NetVolume', type: Volume, value: NaN },
        { name: 'NetArea', type: Area, value: Infinity },
        { name: 'Length', type: Length, value: 2 },
      ]),
    ]);
    assert.deepStrictEqual(picked.map((p) => p.quantityType), [Length]);
  });

  it('merges across several quantity sets on the same element', () => {
    const picked = pickElementQuantities([
      qset('Qto_WallBaseQuantities', [{ name: 'NetVolume', type: Volume, value: 3 }]),
      qset('Qto_BodyGeometryValidation', [{ name: 'NetWeight', type: Weight, value: 80 }]),
    ]);
    assert.deepStrictEqual(
      picked.map((p) => p.quantityType),
      [Volume, Weight],
    );
  });

  it('returns rows in a stable type-then-basis order', () => {
    const picked = pickElementQuantities([
      qset('Qto_X', [
        { name: 'GrossVolume', type: Volume, value: 4 },
        { name: 'Weight', type: Weight, value: 80 },
        { name: 'NetVolume', type: Volume, value: 3 },
        { name: 'Length', type: Length, value: 2 },
        { name: 'NetArea', type: Area, value: 1 },
      ]),
    ]);
    assert.deepStrictEqual(
      picked.map((p) => `${p.quantityType}:${p.basis}`),
      [`${Length}:unqualified`, `${Area}:net`, `${Volume}:net`, `${Volume}:gross`, `${Weight}:unqualified`],
    );
  });

  it('returns nothing for an element with no quantity sets', () => {
    assert.deepStrictEqual(pickElementQuantities([]), []);
    assert.deepStrictEqual(pickElementQuantities([qset('Qto_Empty', [])]), []);
  });

  describe('SI normalisation', () => {
    it('applies the converter, so a millimetre file does not out-sum a metre one', () => {
      // A mm-declared model reports a 2 m³ volume as 2e9 mm³. Adding that to a
      // metre model's 2 without normalising is off by a factor of a billion —
      // and the total still looks like a number, which is what makes it bad.
      const mmToSi = (v: number, t: number) => (t === Volume ? v * 1e-9 : v);
      const picked = pickElementQuantities(
        [qset('Qto_A', [{ name: 'NetVolume', type: Volume, value: 2e9 }])],
        mmToSi,
      );
      assert.ok(Math.abs(picked[0].value - 2) < 1e-9, `expected 2, got ${picked[0].value}`);
    });

    it('leaves values untouched when no converter is supplied', () => {
      const picked = pickElementQuantities([
        qset('Qto_A', [{ name: 'NetVolume', type: Volume, value: 2 }]),
      ]);
      assert.strictEqual(picked[0].value, 2);
    });

    it('passes the quantity type to the converter so each family scales alone', () => {
      // A mm file's area scale is 1e-6 while its volume scale is 1e-9 — one
      // scale for everything is wrong for at least one of them.
      const seen: number[] = [];
      pickElementQuantities(
        [qset('Qto_A', [
          { name: 'NetArea', type: Area, value: 1 },
          { name: 'NetVolume', type: Volume, value: 1 },
        ])],
        (v, t) => { seen.push(t); return v; },
      );
      assert.deepStrictEqual(seen.sort(), [Area, Volume].sort());
    });

    it('drops a value the converter turned non-finite', () => {
      // The raw value passed the finiteness check; what came back did not.
      const picked = pickElementQuantities(
        [qset('Qto_A', [{ name: 'NetVolume', type: Volume, value: 2 }])],
        () => NaN,
      );
      assert.deepStrictEqual(picked, []);
    });
  });
});

describe('rollupQuantities', () => {
  it('totals each bucket across elements and counts the contributors', () => {
    const rollups = rollupQuantities([
      pickElementQuantities([qset('Qto_A', [{ name: 'NetVolume', type: Volume, value: 3 }])]),
      pickElementQuantities([qset('Qto_A', [{ name: 'NetVolume', type: Volume, value: 4.5 }])]),
    ]);
    assert.strictEqual(rollups.length, 1);
    assert.strictEqual(rollups[0].total, 7.5);
    assert.strictEqual(rollups[0].contributing, 2);
  });

  it('counts only the elements that had a value, not the whole selection', () => {
    // Three elements selected, one with no quantities at all. Reporting
    // "3 of 3 contributed" would hide that a third of the selection is missing
    // from the total.
    const rollups = rollupQuantities([
      pickElementQuantities([qset('Qto_A', [{ name: 'NetVolume', type: Volume, value: 3 }])]),
      pickElementQuantities([]),
      pickElementQuantities([qset('Qto_A', [{ name: 'NetVolume', type: Volume, value: 1 }])]),
    ]);
    assert.strictEqual(rollups[0].contributing, 2);
    assert.strictEqual(rollups[0].total, 4);
  });

  it('never merges net into gross', () => {
    const rollups = rollupQuantities([
      pickElementQuantities([
        qset('Qto_A', [
          { name: 'NetVolume', type: Volume, value: 3 },
          { name: 'GrossVolume', type: Volume, value: 4 },
        ]),
      ]),
    ]);
    assert.deepStrictEqual(
      rollups.map((r) => [r.basis, r.total]),
      [['net', 3], ['gross', 4]],
    );
  });

  it('reports every distinct source name summed into a heterogeneous total', () => {
    // A wall's NetSideArea plus a slab's NetArea is still arithmetic, but the
    // reader has to be able to see that the total mixes two different areas.
    const rollups = rollupQuantities([
      pickElementQuantities([qset('Qto_WallBaseQuantities', [{ name: 'NetSideArea', type: Area, value: 5 }])]),
      pickElementQuantities([qset('Qto_SlabBaseQuantities', [{ name: 'NetArea', type: Area, value: 20 }])]),
    ]);
    assert.deepStrictEqual(rollups[0].provenance, [
      'Qto_SlabBaseQuantities.NetArea',
      'Qto_WallBaseQuantities.NetSideArea',
    ]);
  });

  it('deduplicates the source list when every element used the same name', () => {
    const rollups = rollupQuantities([
      pickElementQuantities([qset('Qto_A', [{ name: 'NetVolume', type: Volume, value: 1 }])]),
      pickElementQuantities([qset('Qto_A', [{ name: 'NetVolume', type: Volume, value: 1 }])]),
    ]);
    assert.deepStrictEqual(rollups[0].provenance, ['Qto_A.NetVolume']);
  });

  it('does not let one element contribute twice to a bucket', () => {
    // The no-double-count guarantee is PER ELEMENT, which is why the rollup
    // takes a list per element rather than a flattened list. Handing it one
    // element's three areas must still total a single area.
    const oneElement = pickElementQuantities([
      qset('Qto_X', [
        { name: 'NetSideArea', type: Area, value: 5 },
        { name: 'NetFootprintArea', type: Area, value: 2 },
      ]),
    ]);
    const rollups = rollupQuantities([oneElement]);
    assert.strictEqual(rollups[0].total, 5);
    assert.strictEqual(rollups[0].contributing, 1);
  });

  it('returns nothing for an empty selection', () => {
    assert.deepStrictEqual(rollupQuantities([]), []);
    assert.deepStrictEqual(rollupQuantities([[], []]), []);
  });
});

describe('rollupGeometryVolumes', () => {
  it('sums the proved volumes and counts the unproved separately', () => {
    const r = rollupGeometryVolumes([1.5, undefined, 2.5, undefined, undefined]);
    assert.strictEqual(r.total, 4);
    assert.strictEqual(r.proved, 2);
    assert.strictEqual(r.unproved, 3);
  });

  it('treats an absent volume as unproved, never as zero', () => {
    // The kernel omits the value when it could not prove a closed solid.
    // Reading that as 0 would report a confident, wrong total for an open
    // shell — exactly what #2199 §2 asks the tool not to do.
    const r = rollupGeometryVolumes([undefined, undefined]);
    assert.strictEqual(r.proved, 0);
    assert.strictEqual(r.unproved, 2);
    assert.strictEqual(r.total, 0);
  });

  it('treats a non-finite volume as unproved rather than trusting it', () => {
    const r = rollupGeometryVolumes([NaN, Infinity, 3]);
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.proved, 1);
    assert.strictEqual(r.unproved, 2);
  });

  it('keeps a real zero volume as proved', () => {
    // A proved 0 is a legitimate (degenerate) answer and must not be confused
    // with the absent case above.
    const r = rollupGeometryVolumes([0]);
    assert.strictEqual(r.proved, 1);
    assert.strictEqual(r.unproved, 0);
  });

  it('is all zeroes for an empty selection', () => {
    assert.deepStrictEqual(rollupGeometryVolumes([]), { total: 0, proved: 0, unproved: 0 });
  });
});

describe('rollupMeshArea', () => {
  it('sums the measured areas and counts the unmeasured separately', () => {
    const r = rollupMeshArea([2.5, undefined, 1.5, undefined]);
    assert.strictEqual(r.total, 4);
    assert.strictEqual(r.withMesh, 2);
    assert.strictEqual(r.withoutMesh, 2);
  });

  it('treats an absent area as no-mesh, never as zero', () => {
    // Unlike geometryVolume, an absent mesh area is not gated on solid
    // closedness — it means no triangulated geometry was found at all
    // (e.g. an instanced-only template), and must not silently read as 0.
    const r = rollupMeshArea([undefined, undefined]);
    assert.strictEqual(r.withMesh, 0);
    assert.strictEqual(r.withoutMesh, 2);
    assert.strictEqual(r.total, 0);
  });

  it('treats a non-finite area as no-mesh rather than trusting it', () => {
    const r = rollupMeshArea([NaN, Infinity, 3]);
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.withMesh, 1);
    assert.strictEqual(r.withoutMesh, 2);
  });

  it('keeps a real zero area as measured', () => {
    const r = rollupMeshArea([0]);
    assert.strictEqual(r.withMesh, 1);
    assert.strictEqual(r.withoutMesh, 0);
  });

  it('is all zeroes for an empty selection', () => {
    assert.deepStrictEqual(rollupMeshArea([]), { total: 0, withMesh: 0, withoutMesh: 0 });
  });
});
