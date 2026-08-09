/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createEmptyFlatSymbolic, type FlatSymbolic } from './symbolic-flat.js';
import { buildParseResult, type SymbolicHierarchyInput } from './symbolic-parse.js';

/**
 * Issue #2256 — storey bucketing must treat `worldY === 0` as an elevation.
 *
 * `0` is ground level: the single most common elevation in a building, not an
 * edge case. The bucketer used to demand `Number.isFinite(worldY) && worldY
 * !== 0`, so a symbol authored at datum was indistinguishable from one whose
 * elevation the extractor never resolved, and fell through to the storey
 * table — into the loose bucket (which renders at the model's mid-height
 * `fallbackY`) for the hierarchy-less exports that fallback exists to serve.
 *
 * The producer now spells "no elevation" `NaN`
 * (`rust/processing/src/symbolic/elevation.rs`), so these tests must pin BOTH
 * sides: `0` buckets, `NaN` falls back. A test that only exercises a non-zero
 * elevation passes with or without the bug and proves nothing.
 */

const ANNOTATION = 0;
const GRID_AXIS = 1;
const OWNER = 100;

/** One two-point polyline at `worldY`, owned by {@link OWNER}. */
function onePolylineAt(worldY: number, typeIndex = ANNOTATION): FlatSymbolic {
  return {
    ...createEmptyFlatSymbolic(),
    typeNames: ['IfcAnnotation', 'IfcGridAxis'],
    polyPoints: Float32Array.from([0, 0, 1, 1]),
    polyStart: Uint32Array.from([0, 2]),
    polyOwner: Uint32Array.from([OWNER]),
    polyWorldY: Float32Array.from([worldY]),
    polyFlags: Uint8Array.from([0]),
    polyType: Uint16Array.from([typeIndex]),
  };
}

/** One text literal at `worldY`. */
function oneTextAt(worldY: number): FlatSymbolic {
  return {
    ...createEmptyFlatSymbolic(),
    typeNames: ['IfcAnnotation'],
    textContent: ['label'],
    textAlignment: ['center'],
    textX: Float32Array.from([0]),
    textY: Float32Array.from([0]),
    textDirX: Float32Array.from([1]),
    textDirY: Float32Array.from([0]),
    textHeight: Float32Array.from([0.2]),
    textTargetPx: Float32Array.from([0]),
    textColor: Float32Array.from([0, 0, 0, 0]),
    textOwner: Uint32Array.from([OWNER]),
    textWorldY: Float32Array.from([worldY]),
    textType: Uint16Array.from([ANNOTATION]),
  };
}

/** One triangular fill at `worldY`. */
function oneFillAt(worldY: number): FlatSymbolic {
  return {
    ...createEmptyFlatSymbolic(),
    typeNames: ['IfcAnnotation'],
    fillPoints: Float32Array.from([0, 0, 1, 0, 1, 1]),
    fillPointStart: Uint32Array.from([0, 6]),
    fillHoles: new Uint32Array(0),
    fillHoleStart: Uint32Array.from([0, 0]),
    fillColor: Float32Array.from([0, 0, 0, 1]),
    fillHatch: Float32Array.from([0, 0, 0, 0]),
    fillOwner: Uint32Array.from([OWNER]),
    fillWorldY: Float32Array.from([worldY]),
    fillFlags: Uint8Array.from([0]),
    fillType: Uint16Array.from([ANNOTATION]),
  };
}

/** No spatial hierarchy at all — `SpatialHierarchyBuilder` found no storeys. */
const NO_HIERARCHY: SymbolicHierarchyInput = {};

/** A hierarchy that would put {@link OWNER} at 7 m if consulted. */
const HIERARCHY_AT_7: SymbolicHierarchyInput = {
  elementToStorey: new Map([[OWNER, 9]]),
  storeyElevations: new Map([[9, 7]]),
};

/** Bucket keys plus loose-segment count, the two outcomes that differ. */
function placement(result: ReturnType<typeof buildParseResult>) {
  return {
    keys: [...result.byStorey.keys()],
    elevations: [...result.byStorey.values()].map((b) => b.storeyElevation),
    loose: result.loose.length,
  };
}

describe('symbolic storey bucketing: worldY 0 is an elevation (#2256)', () => {
  it('buckets a datum annotation at 0 instead of dropping it loose', () => {
    const result = buildParseResult(onePolylineAt(0), NO_HIERARCHY);
    assert.deepStrictEqual(placement(result), { keys: [0], elevations: [0], loose: 0 });
  });

  it('keeps an unresolved (NaN) annotation loose when there is no storey table', () => {
    const result = buildParseResult(onePolylineAt(Number.NaN), NO_HIERARCHY);
    assert.deepStrictEqual(placement(result), { keys: [], elevations: [], loose: 1 });
  });

  /**
   * The distinction, in one assertion: same fixture, same hierarchy, only the
   * `worldY` differs — `0` must keep its own elevation while `NaN` takes the
   * storey table's. Before the fix both produced the 7 m bucket.
   */
  it('separates a datum elevation from an unresolved one against the same storey table', () => {
    const datum = buildParseResult(onePolylineAt(0), HIERARCHY_AT_7);
    const unresolved = buildParseResult(onePolylineAt(Number.NaN), HIERARCHY_AT_7);

    assert.deepStrictEqual(placement(datum), { keys: [0], elevations: [0], loose: 0 });
    assert.deepStrictEqual(placement(unresolved), { keys: [7000], elevations: [7], loose: 0 });
    assert.notDeepStrictEqual(
      placement(datum),
      placement(unresolved),
      'datum and unresolved must not land in the same bucket',
    );
  });

  it('buckets a basement annotation at its negative elevation', () => {
    const result = buildParseResult(onePolylineAt(-3.5), NO_HIERARCHY);
    assert.deepStrictEqual(placement(result), { keys: [-3500], elevations: [-3.5], loose: 0 });
  });

  it('leaves a non-zero elevation exactly where it was', () => {
    const result = buildParseResult(onePolylineAt(5), NO_HIERARCHY);
    assert.deepStrictEqual(placement(result), { keys: [5000], elevations: [5], loose: 0 });
  });

  it('applies the same rule to grid axes, which bucket separately', () => {
    const datum = buildParseResult(onePolylineAt(0, GRID_AXIS), NO_HIERARCHY);
    assert.deepStrictEqual([...datum.gridByStorey.keys()], [0]);
    assert.strictEqual(datum.gridLoose.length, 0);
    assert.strictEqual(datum.byStorey.size, 0, 'grid axes must not leak into the annotation map');

    const unresolved = buildParseResult(onePolylineAt(Number.NaN, GRID_AXIS), NO_HIERARCHY);
    assert.deepStrictEqual([...unresolved.gridByStorey.keys()], []);
    assert.strictEqual(unresolved.gridLoose.length, 1);
  });

  it('applies the same rule to texts and fills, not just lines', () => {
    const datumText = buildParseResult(oneTextAt(0), NO_HIERARCHY);
    assert.deepStrictEqual([...datumText.byStorey.keys()], [0]);
    assert.strictEqual(datumText.looseTexts.length, 0);
    assert.strictEqual(buildParseResult(oneTextAt(Number.NaN), NO_HIERARCHY).looseTexts.length, 1);

    const datumFill = buildParseResult(oneFillAt(0), NO_HIERARCHY);
    assert.deepStrictEqual([...datumFill.byStorey.keys()], [0]);
    assert.strictEqual(datumFill.looseFills.length, 0);
    assert.strictEqual(buildParseResult(oneFillAt(Number.NaN), NO_HIERARCHY).looseFills.length, 1);
  });

  /**
   * The sentinel has to survive the worker hop, or the fix reappears as a bug
   * on the far side: a `Float32Array` keeps `NaN`, but `structuredClone` of a
   * plain object would not keep an `undefined`.
   */
  it('keeps 0 and NaN distinct across a structured clone', () => {
    for (const worldY of [0, Number.NaN]) {
      const flat = onePolylineAt(worldY);
      const direct = buildParseResult(flat, NO_HIERARCHY);
      const cloned = buildParseResult(structuredClone(flat), NO_HIERARCHY);
      assert.deepStrictEqual(placement(cloned), placement(direct));
    }
  });
});
