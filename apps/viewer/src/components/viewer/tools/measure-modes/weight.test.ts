/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #2736's acceptance, stated as assertions.
 *
 * The three bullets the issue names are covered by, in order:
 * - "derives a mass ..."           — geometry + density with nothing declared
 * - "an untrusted volume ..."      — the #1993 refusal, asserted directly
 * - the mutation bullet            — `multiplies the volume by the density`
 *   pins the arithmetic and `reads the density off Pset_MaterialCommon`
 *   pins the lookup, so mutating either reds a named test.
 *
 * The fourth group exists because the derivation tests alone would pass for an
 * implementation that ALWAYS derives: a declared weight must still come back
 * labelled `declared`, and must not be recomputed from geometry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveElementWeight,
  rollupWeights,
  pickIfcDensity,
  classifyWeightUnitKind,
  type MaterialPsetGroupLike,
  type WeightOutcome,
} from './weight.js';

const CONCRETE = 2400;

/** A density pick as `pickIfcDensity` would have produced it. */
const ifcDensity = (density = CONCRETE) =>
  ({
    kind: 'density',
    pick: { density, basis: 'derived-ifc-density', provenance: 'Concrete · Pset_MaterialCommon.MassDensity' },
  }) as const;

const libraryDensity = (density = CONCRETE) =>
  ({
    kind: 'density',
    pick: { density, basis: 'derived-library-density', provenance: 'project library · Concrete' },
  }) as const;

const materialGroup = (
  materialName: string,
  psetName: string,
  properties: Array<{ name: string; value: unknown }>,
): MaterialPsetGroupLike => ({ materialName, psets: [{ name: psetName, properties }] });

describe('resolveElementWeight — derivation (#2736 acceptance 1)', () => {
  it('derives a mass from geometry volume and material density when nothing is declared', () => {
    const out = resolveElementWeight({
      volume: 2,
      volumeTrusted: true,
      density: ifcDensity(),
    });
    assert.equal(out.kind, 'weight');
    assert.ok(out.kind === 'weight');
    assert.equal(out.weight.value, 4800);
  });

  it('multiplies the volume by the density', () => {
    // Pins the arithmetic itself, so swapping the operator or dropping either
    // operand cannot stay green. Deliberately uses two values whose sum,
    // difference and quotient all differ from their product.
    const out = resolveElementWeight({ volume: 3, volumeTrusted: true, density: ifcDensity(7) });
    assert.ok(out.kind === 'weight');
    assert.equal(out.weight.value, 21);
    assert.notEqual(out.weight.value, 3 + 7);
    assert.notEqual(out.weight.value, 3 / 7);
  });

  it('labels the result derived, never plain "declared"', () => {
    const fromFile = resolveElementWeight({ volume: 1, volumeTrusted: true, density: ifcDensity() });
    assert.ok(fromFile.kind === 'weight');
    assert.equal(fromFile.weight.basis, 'derived-ifc-density');

    const fromLibrary = resolveElementWeight({
      volume: 1,
      volumeTrusted: true,
      density: libraryDensity(),
    });
    assert.ok(fromLibrary.kind === 'weight');
    assert.equal(fromLibrary.weight.basis, 'derived-library-density');
  });

  it('carries the density source through as the result provenance', () => {
    const out = resolveElementWeight({ volume: 1, volumeTrusted: true, density: ifcDensity() });
    assert.ok(out.kind === 'weight');
    assert.equal(out.weight.provenance, 'Concrete · Pset_MaterialCommon.MassDensity');
  });
});

describe('resolveElementWeight — refusals (#2736 acceptance 2)', () => {
  it('produces NO mass from an untrusted volume, rather than a wrong one', () => {
    // The #1993 case: federation alignment re-baked the vertices, so the
    // proved volume describes a size that is no longer on screen. There IS a
    // volume and there IS a density; the answer is still nothing.
    const out = resolveElementWeight({
      volume: 2,
      volumeTrusted: false,
      density: ifcDensity(),
    });
    assert.equal(out.kind, 'none');
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'volume-untrusted');
  });

  it('distinguishes an untrusted volume from an absent one', () => {
    const absent = resolveElementWeight({ volumeTrusted: true, density: ifcDensity() });
    assert.ok(absent.kind === 'none');
    assert.equal(absent.reason, 'no-volume');
  });

  it('gives no mass when no density could be found', () => {
    const out = resolveElementWeight({ volume: 2, volumeTrusted: true });
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'no-density');
  });

  it('treats a zero or negative density as no density, never as a zero-kilogram answer', () => {
    for (const bad of [0, -5]) {
      const out = resolveElementWeight({ volume: 2, volumeTrusted: true, density: ifcDensity(bad) });
      assert.ok(out.kind === 'none', `density ${bad} must not produce a weight`);
      assert.equal(out.reason, 'no-density');
    }
  });

  it('gives no mass when a non-finite volume masquerades as a proved one', () => {
    const out = resolveElementWeight({
      volume: Number.NaN,
      volumeTrusted: true,
      density: ifcDensity(),
    });
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'no-volume');
  });

  it('declines to derive when the file\'s MASSUNIT resolved to a force', () => {
    const out = resolveElementWeight({
      volume: 2,
      volumeTrusted: true,
      density: ifcDensity(),
      unitKind: 'force',
    });
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'weight-unit-is-force');
  });

  it('passes a density conflict through as its own reason, not as "no density"', () => {
    const out = resolveElementWeight({
      volume: 2,
      volumeTrusted: true,
      density: { kind: 'none', reason: 'density-ambiguous' },
    });
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'density-ambiguous');
  });
});

describe('resolveElementWeight — a declared weight is never derived over', () => {
  it('reports a declared weight as declared', () => {
    const out = resolveElementWeight({
      declared: { value: 1234, provenance: 'Qto_WallBaseQuantities.NetWeight' },
      volumeTrusted: true,
    });
    assert.ok(out.kind === 'weight');
    assert.equal(out.weight.basis, 'declared');
    assert.equal(out.weight.value, 1234);
    assert.equal(out.weight.provenance, 'Qto_WallBaseQuantities.NetWeight');
  });

  it('does NOT overwrite a declared weight with a derivation, even when both are available', () => {
    // An implementation that always derives would pass every test above and
    // silently replace the file's own number with ours. 2 m³ x 2400 kg/m³ is
    // 4800, and the declared 1234 must survive it.
    const out = resolveElementWeight({
      declared: { value: 1234, provenance: 'Qto_WallBaseQuantities.NetWeight' },
      volume: 2,
      volumeTrusted: true,
      density: ifcDensity(),
    });
    assert.ok(out.kind === 'weight');
    assert.equal(out.weight.value, 1234);
    assert.equal(out.weight.basis, 'declared');
  });

  it('still reports a declared weight when the volume is untrusted', () => {
    // The untrusted-volume refusal is about DERIVING. It must not suppress a
    // number the file itself authored, which no alignment touched.
    const out = resolveElementWeight({
      declared: { value: 50, provenance: 'Qto_BeamBaseQuantities.GrossWeight' },
      volume: 2,
      volumeTrusted: false,
      density: ifcDensity(),
    });
    assert.ok(out.kind === 'weight');
    assert.equal(out.weight.basis, 'declared');
    assert.equal(out.weight.value, 50);
  });

  it('drops a non-finite declared weight rather than reporting it', () => {
    const out = resolveElementWeight({
      declared: { value: Number.NaN, provenance: 'Qto_Bad.Weight' },
      volumeTrusted: true,
    });
    assert.ok(out.kind === 'none');
  });
});

describe('pickIfcDensity — the density lookup (#2736 acceptance 3)', () => {
  it('reads the density off Pset_MaterialCommon.MassDensity', () => {
    // Pins BOTH names. Mutating either the pset name or the property name the
    // lookup matches on reds this test.
    const out = pickIfcDensity([
      materialGroup('Concrete C30/37', 'Pset_MaterialCommon', [{ name: 'MassDensity', value: 2400 }]),
    ]);
    assert.equal(out.kind, 'density');
    assert.ok(out.kind === 'density');
    assert.equal(out.pick.density, 2400);
    assert.equal(out.pick.basis, 'derived-ifc-density');
    assert.equal(out.pick.provenance, 'Concrete C30/37 · Pset_MaterialCommon.MassDensity');
  });

  it('ignores a density-looking property in a DIFFERENT pset', () => {
    const out = pickIfcDensity([
      materialGroup('Steel', 'Pset_MaterialSteel', [{ name: 'MassDensity', value: 7850 }]),
    ]);
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'no-density');
  });

  it('ignores a different property in the right pset', () => {
    const out = pickIfcDensity([
      materialGroup('Timber', 'Pset_MaterialCommon', [{ name: 'Porosity', value: 0.3 }]),
    ]);
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'no-density');
  });

  it('matches the pset and property names case-insensitively', () => {
    const out = pickIfcDensity([
      materialGroup('Brick', 'PSET_MATERIALCOMMON', [{ name: 'massdensity', value: 1800 }]),
    ]);
    assert.ok(out.kind === 'density');
    assert.equal(out.pick.density, 1800);
  });

  it('refuses a stringly-typed density instead of coercing it', () => {
    const out = pickIfcDensity([
      materialGroup('Concrete', 'Pset_MaterialCommon', [{ name: 'MassDensity', value: '2400' }]),
    ]);
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'no-density');
  });

  it('applies the SI converter, so a file declaring g/cm³ does not out-weigh one in kg/m³', () => {
    const out = pickIfcDensity(
      [materialGroup('Concrete', 'Pset_MaterialCommon', [{ name: 'MassDensity', value: 2.4 }])],
      (v) => v * 1000,
    );
    assert.ok(out.kind === 'density');
    assert.equal(out.pick.density, 2400);
  });

  it('drops a value the converter turned non-finite', () => {
    const out = pickIfcDensity(
      [materialGroup('Concrete', 'Pset_MaterialCommon', [{ name: 'MassDensity', value: 2400 }])],
      () => Number.NaN,
    );
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'no-density');
  });

  it('reports a conflict when two materials declare different densities, rather than picking one', () => {
    // A layered wall is not its heaviest layer, and it is not the mean of its
    // layers either. Without each layer's volume there is no answer.
    const out = pickIfcDensity([
      materialGroup('Concrete', 'Pset_MaterialCommon', [{ name: 'MassDensity', value: 2400 }]),
      materialGroup('Insulation', 'Pset_MaterialCommon', [{ name: 'MassDensity', value: 30 }]),
    ]);
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'density-ambiguous');
  });

  it('accepts two materials that agree on the density', () => {
    const out = pickIfcDensity([
      materialGroup('Concrete A', 'Pset_MaterialCommon', [{ name: 'MassDensity', value: 2400 }]),
      materialGroup('Concrete B', 'Pset_MaterialCommon', [{ name: 'MassDensity', value: 2400 }]),
    ]);
    assert.ok(out.kind === 'density');
    assert.equal(out.pick.density, 2400);
  });

  it('finds no density in an element with no materials at all', () => {
    const out = pickIfcDensity([]);
    assert.ok(out.kind === 'none');
    assert.equal(out.reason, 'no-density');
  });
});

describe('classifyWeightUnitKind', () => {
  it('reads a mass unit as a mass', () => {
    for (const symbol of ['kg', 'g', 't', 'lb']) {
      assert.equal(classifyWeightUnitKind(symbol), 'mass', symbol);
    }
  });

  it('reads a force symbol declared under MASSUNIT as a force', () => {
    for (const symbol of ['N', 'kN', 'lbf', 'kip']) {
      assert.equal(classifyWeightUnitKind(symbol), 'force', symbol);
    }
  });

  it('treats a file that declares no MASSUNIT as a mass, matching the kg default', () => {
    // Not a third "unknown" state: `QUANTITY_TYPE_UNIT` already defaults
    // QuantityType.Weight to kilograms, and suppressing the derivation for
    // every unit-less file would be a refusal with nothing behind it.
    assert.equal(classifyWeightUnitKind(undefined), 'mass');
  });
});

describe('rollupWeights', () => {
  const derived = (value: number): WeightOutcome => ({
    kind: 'weight',
    weight: { basis: 'derived-ifc-density', value, provenance: 'Concrete · Pset_MaterialCommon.MassDensity' },
  });
  const declared = (value: number): WeightOutcome => ({
    kind: 'weight',
    weight: { basis: 'declared', value, provenance: 'Qto_WallBaseQuantities.NetWeight' },
  });

  it('never sums a declared weight into a derived one', () => {
    // The defect this whole module exists to avoid: one number labelled
    // "Weight" that is part measurement and part estimate.
    const { rows } = rollupWeights([declared(100), derived(50)]);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.basis, r.total]),
      [['declared', 100], ['derived-ifc-density', 50]],
    );
  });

  it('keeps the two derived bases apart from each other too', () => {
    const { rows } = rollupWeights([
      derived(50),
      { kind: 'weight', weight: { basis: 'derived-library-density', value: 7, provenance: 'library · Steel' } },
    ]);
    assert.deepEqual(
      rows.map((r) => [r.basis, r.total]),
      [['derived-ifc-density', 50], ['derived-library-density', 7]],
    );
  });

  it('totals within a basis and counts its contributors', () => {
    const { rows } = rollupWeights([derived(50), derived(25), { kind: 'none', reason: 'no-volume' }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total, 75);
    assert.equal(rows[0].contributing, 2);
  });

  it('counts every withheld element by its reason', () => {
    const { withheld } = rollupWeights([
      { kind: 'none', reason: 'volume-untrusted' },
      { kind: 'none', reason: 'volume-untrusted' },
      { kind: 'none', reason: 'no-density' },
      { kind: 'none', reason: 'density-ambiguous' },
      { kind: 'none', reason: 'weight-unit-is-force' },
      derived(1),
    ]);
    assert.equal(withheld['volume-untrusted'], 2);
    assert.equal(withheld['no-density'], 1);
    assert.equal(withheld['density-ambiguous'], 1);
    assert.equal(withheld['weight-unit-is-force'], 1);
    assert.equal(withheld['no-volume'], 0);
  });

  it('deduplicates the provenance list and sorts it', () => {
    const { rows } = rollupWeights([derived(1), derived(2)]);
    assert.deepEqual(rows[0].provenance, ['Concrete · Pset_MaterialCommon.MassDensity']);
  });

  it('is empty for an empty selection, with every reason at zero', () => {
    const { rows, withheld } = rollupWeights([]);
    assert.deepEqual(rows, []);
    assert.deepEqual(Object.values(withheld), [0, 0, 0, 0, 0]);
  });
});
