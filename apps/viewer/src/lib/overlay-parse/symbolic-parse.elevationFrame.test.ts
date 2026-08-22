/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ensureBucket` picks a bucket elevation from one of two sources — the wasm
 * extractor's `primitive.worldY` or `IfcBuildingStorey.Elevation` — and the
 * buckets they produce are lifted into ONE scene by `useSymbolicAnnotations`
 * and section-clipped against ONE render-frame band. The two sources arrive
 * in different frames (the wasm one has already had the RTC Z removed, the
 * storey table is raw IFC Z), so a bucket's elevation must not depend on
 * which source resolved it.
 *
 * The fixture deliberately avoids the symmetries that would hide the bug:
 * the two rebase components are non-zero and DIFFERENT from each other, the
 * two annotations sit at different elevations, and the elevation the storey
 * table reports is chosen so that a wrong rebase lands on a *plausible*
 * number rather than an obviously broken one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildParseResult } from './symbolic-parse.js';
import { createEmptyFlatSymbolic, type FlatSymbolic } from './symbolic-flat.js';

/** originShift.y for the fixture model, metres. */
const SHIFT_Y = 2.5;
/** wasmRtcOffset.z (IFC elevation component of the RTC offset), metres. */
const RTC_Z = 407;
const REBASE = { primitive: SHIFT_Y, storeyTable: SHIFT_Y + RTC_Z };

/** Raw IFC elevation of the storey the table resolves to. */
const TABLE_ELEVATION_IFC = 415;
/** The wasm primitive's elevation — RTC Z already removed, shift still on. */
const PRIMITIVE_WORLD_Y = 415 - RTC_Z;

/** Two annotations: #1 carries a resolvable `worldY`, #2 does not (NaN) and
 *  falls back to the storey table. Both belong to the same storey, so a
 *  frame-correct build puts them in the SAME bucket. */
function flatWithTwoAnnotations(): FlatSymbolic {
  const flat = createEmptyFlatSymbolic();
  flat.typeNames = ['IfcAnnotation'];
  flat.polyPoints = Float32Array.from([0, 0, 1, 0, 4, 3, 5, 3]);
  flat.polyStart = Uint32Array.from([0, 2, 4]);
  flat.polyOwner = Uint32Array.from([1, 2]);
  flat.polyWorldY = Float32Array.from([PRIMITIVE_WORLD_Y, NaN]);
  flat.polyFlags = Uint8Array.from([0, 0]);
  flat.polyType = Uint16Array.from([0, 0]);
  return flat;
}

const HIERARCHY = {
  elementToStorey: new Map([[2, 90]]),
  storeyElevations: new Map([[90, TABLE_ELEVATION_IFC]]),
};

describe('buildParseResult elevation frames', () => {
  it('puts both elevation sources in the render frame, so they share a bucket', () => {
    const result = buildParseResult(flatWithTwoAnnotations(), {
      ...HIERARCHY,
      elevationRebase: REBASE,
    });

    const buckets = [...result.byStorey.values()];
    assert.strictEqual(
      buckets.length,
      1,
      `both annotations sit on one storey, so a frame-correct build makes one `
        + `bucket; got ${buckets.length} at elevations `
        + `${buckets.map((b) => b.storeyElevation).join(', ')}`,
    );
    const only = buckets[0].storeyElevation;
    assert.ok(only !== null, 'the bucket must carry a resolved elevation');
    assert.ok(
      Math.abs(only - (TABLE_ELEVATION_IFC - RTC_Z - SHIFT_Y)) < 1e-6,
      `expected renderY = ifcZ - rtc.z - originShift.y = `
        + `${TABLE_ELEVATION_IFC - RTC_Z - SHIFT_Y}, got ${only}`,
    );
    assert.strictEqual(buckets[0].lines.length, 2, 'both annotations land in the bucket');
  });

  it('leaves both sources untouched when the model needs no rebasing', () => {
    const result = buildParseResult(flatWithTwoAnnotations(), HIERARCHY);
    const elevations = [...result.byStorey.values()]
      .map((b) => b.storeyElevation ?? NaN)
      .sort((a, b) => a - b);
    assert.deepStrictEqual(
      elevations,
      [PRIMITIVE_WORLD_Y, TABLE_ELEVATION_IFC].sort((a, b) => a - b),
      'an absent rebase must not move either source',
    );
  });
});
