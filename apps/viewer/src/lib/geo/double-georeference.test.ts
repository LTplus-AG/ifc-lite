/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';

import { detectDoubleGeoreference, formatApproxDistance } from './double-georeference.js';
import { effectiveMapConversionForGeometry } from './map-absolute.js';

/**
 * Build a CoordinateInfo whose model centre lands on the given IFC world
 * position (Z-up metres). `computeModelCenterInIfcMeters` reads
 * `shiftedBounds` + `originShift` + `wasmRtcOffset` and maps viewer Y-up back
 * to IFC Z-up as `ifcX = worldX`, `ifcY = -worldZ`. Putting the whole position
 * in `originShift` with zero-extent bounds keeps that inversion trivial and
 * keeps these tests about the detector, not about the axis swap (which
 * reproject.test.ts already pins).
 */
function coordInfoAt(
  ifcX: number,
  ifcY: number,
  halfExtent = 0,
  buildingRotation?: number,
): CoordinateInfo {
  const originShift = { x: ifcX, y: 0, z: -ifcY };
  const shiftedBounds = {
    min: { x: -halfExtent, y: 0, z: -halfExtent },
    max: { x: halfExtent, y: 0, z: halfExtent },
  };
  return {
    originShift,
    shiftedBounds,
    // The producer's invariant: shiftedBounds = originalBounds - originShift.
    originalBounds: {
      min: {
        x: shiftedBounds.min.x + originShift.x,
        y: shiftedBounds.min.y + originShift.y,
        z: shiftedBounds.min.z + originShift.z,
      },
      max: {
        x: shiftedBounds.max.x + originShift.x,
        y: shiftedBounds.max.y + originShift.y,
        z: shiftedBounds.max.z + originShift.z,
      },
    },
    hasLargeCoordinates: true,
    buildingRotation,
  };
}

/** The reporter's file (#2526): Vectorworks, EPSG:25833, mm project, m MapUnit. */
const ISSUE_2526_CONVERSION: MapConversion = {
  id: 73,
  sourceCRS: 41,
  targetCRS: 71,
  eastings: 311988.181,
  northings: 5996148.565,
  orthogonalHeight: 0,
  xAxisAbscissa: 0,
  xAxisOrdinate: 1,
  scale: undefined,
};

/** Site placement #49 = (311988180.54, 5996148564.99) mm, i.e. the anchor. */
const ISSUE_2526_CENTER = { x: 311988.18054, y: 5996148.56499 };

const METRE_CRS: Pick<ProjectedCRS, 'mapUnitScale'> = { mapUnitScale: 1 };

describe('detectDoubleGeoreference', () => {
  it('reports the issue #2526 file and quotes the displacement a literal tool would produce', () => {
    const found = detectDoubleGeoreference(
      ISSUE_2526_CONVERSION,
      METRE_CRS,
      coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y),
      0.001,
    );
    assert.ok(found, 'expected a double georeference report');
    assert.ok(found!.residual < 1, `residual should be sub-metre, got ${found!.residual}`);
    // The file's 90° rotation swings the (map-sized) world centre too, so the
    // error is NOT simply ‖offset‖: the model goes from (X, Y) to (E - Y, N + X),
    // i.e. hypot(E - Y - X, N + X - Y) ≈ 6 004 km in projected metres. (The
    // 5 206 km quoted in the issue is the geodesic distance measured after the
    // inverse projection — a different, smaller quantity.)
    assert.ok(
      Math.abs(found!.displacement - 6_004_000) < 10_000,
      `expected ≈6 004 km of displacement, got ${found!.displacement}`,
    );
  });

  /**
   * The whole point of this module after #2534: the note the panel shows and
   * the correction the geometry pipeline applies must be the SAME decision.
   * A model that is silently corrected but not explained, or explained but not
   * corrected, is the incoherence this reconciliation exists to remove.
   */
  describe('agrees with the geometry correction, model for model', () => {
    it('reports exactly when the geometry guard neutralises — no gap in either direction', () => {
      // Residuals sweeping across the guard's 10 km window, including 6 004 m
      // and 8 000 m, which straddle the tolerance the DETECTOR used to carry
      // (max(1 km, 0.1% of ‖offset‖) ≈ 6 004 m for this anchor). Anything in
      // that band was corrected without being reported.
      for (const residual of [0, 1_000, 6_004, 8_000, 9_999, 10_001, 20_000, 400_000]) {
        const info = coordInfoAt(ISSUE_2526_CENTER.x + residual, ISSUE_2526_CENTER.y);
        const reported = detectDoubleGeoreference(
          ISSUE_2526_CONVERSION,
          METRE_CRS,
          info,
          0.001,
        ) !== null;
        const corrected = effectiveMapConversionForGeometry(
          ISSUE_2526_CONVERSION,
          1,
          info,
        ) !== ISSUE_2526_CONVERSION;
        assert.strictEqual(
          reported,
          corrected,
          `residual ${residual} m: reported=${reported} but corrected=${corrected}`,
        );
      }
    });

    it('reports a model 8 km from its anchor, which the old detector tolerance missed', () => {
      // The specific gap: 8 km > max(1 km, 0.1% × 6 004 km) = 6 004 m, so the
      // pre-reconciliation detector stayed silent while the geometry was
      // already being moved.
      const info = coordInfoAt(ISSUE_2526_CENTER.x + 8_000, ISSUE_2526_CENTER.y);
      assert.notStrictEqual(
        effectiveMapConversionForGeometry(ISSUE_2526_CONVERSION, 1, info),
        ISSUE_2526_CONVERSION,
        'precondition: the geometry guard corrects this model',
      );
      assert.ok(
        detectDoubleGeoreference(ISSUE_2526_CONVERSION, METRE_CRS, info, 0.001),
        'a corrected model must also be explained',
      );
    });

    it('stays silent whenever the guard returns the conversion untouched', () => {
      // Same anchor, geometry 400 km away: the guard cannot fire, so there is
      // nothing to explain and a note would describe a correction that never
      // happened.
      const info = coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y - 400_000);
      assert.strictEqual(
        effectiveMapConversionForGeometry(ISSUE_2526_CONVERSION, 1, info),
        ISSUE_2526_CONVERSION,
        'precondition: the geometry guard leaves this model alone',
      );
      assert.strictEqual(
        detectDoubleGeoreference(ISSUE_2526_CONVERSION, METRE_CRS, info, 0.001),
        null,
      );
    });
  });

  describe('overridesAuthoredRotation', () => {
    // The fingerprint matches on TRANSLATION, so it does not prove the model's
    // local axes are grid-aligned. The guard resets the axis anyway (a
    // non-identity rotation acting on a map-sized coordinate is unrecoverable
    // whatever the offsets are), so this flag tells the UI when the orientation
    // on screen is OUR choice rather than a restatement of the file's.

    it('is true whenever the file authors a rotation of its own', () => {
      const found = detectDoubleGeoreference(
        ISSUE_2526_CONVERSION,
        METRE_CRS,
        coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y),
        0.001,
      );
      assert.ok(found);
      assert.strictEqual(found!.overridesAuthoredRotation, true);
    });

    it('stays true even when the site placement carries its own rotation', () => {
      // A rotating placement is evidence that the world frame IS the map frame,
      // but not proof: the placement rotation and the conversion axis can
      // simply disagree (they do here — -117.833° vs +90°). Treating it as
      // corroboration would silently pick one, which is what the flag exists to
      // prevent.
      const found = detectDoubleGeoreference(
        ISSUE_2526_CONVERSION,
        METRE_CRS,
        coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y, 0, -2.0566),
        0.001,
      );
      assert.ok(found);
      assert.strictEqual(found!.overridesAuthoredRotation, true);
    });

    it('is false when the conversion authors no rotation at all', () => {
      const noRotation: MapConversion = {
        ...ISSUE_2526_CONVERSION,
        xAxisAbscissa: 1,
        xAxisOrdinate: 0,
      };
      const found = detectDoubleGeoreference(
        noRotation,
        METRE_CRS,
        coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y),
        0.001,
      );
      assert.ok(found);
      assert.strictEqual(found!.overridesAuthoredRotation, false);
    });
  });

  describe('overridesAuthoredScale', () => {
    it('is false when the effective horizontal scale is already 1', () => {
      // #2526's file: Scale unset on a mm project with a metre MapUnit, which
      // getEffectiveHorizontalScale already resolves to 1. Nothing about the
      // model's size is being overridden, so the note must not claim it is.
      const found = detectDoubleGeoreference(
        ISSUE_2526_CONVERSION,
        METRE_CRS,
        coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y),
        0.001,
      );
      assert.ok(found);
      assert.strictEqual(found!.overridesAuthoredScale, false);
    });

    it('is true for a NEAR-unit scale whose induced drift is still kilometres', () => {
      // Effective scale 1.004 is inside detectScaleUnitMismatch's 0.5% band,
      // but multiplied by a ~6 000 km coordinate it drags the model ~24 km. A
      // fraction-based tolerance would wave this through; the guard pins
      // Scale to 1, and the user is entitled to know their Scale was dropped.
      const nearUnit: MapConversion = { ...ISSUE_2526_CONVERSION, scale: 1.004 };
      const found = detectDoubleGeoreference(
        nearUnit,
        METRE_CRS,
        coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y),
        1,
      );
      assert.ok(found);
      assert.strictEqual(found!.overridesAuthoredScale, true);
    });

    it('is false for a genuine foot/metre bridge', () => {
      // A real bridge needs the units to DIFFER: a foot project with a metre
      // MapUnit, and Scale = 0.3048 doing exactly what the schema asks. The
      // effective scale is then (0.3048 × 1) / 0.3048 = 1 — nothing is
      // overridden, so nothing is claimed.
      const footProject: MapConversion = { ...ISSUE_2526_CONVERSION, scale: 0.3048 };
      const found = detectDoubleGeoreference(
        footProject,
        METRE_CRS,
        coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y),
        0.3048,
      );
      assert.ok(found);
      assert.strictEqual(found!.overridesAuthoredScale, false);
    });
  });

  it('does NOT report a correctly authored local-frame model', () => {
    // Geometry near the IFC origin, conversion carries the real site offset.
    assert.strictEqual(
      detectDoubleGeoreference(ISSUE_2526_CONVERSION, METRE_CRS, coordInfoAt(12, -30), 0.001),
      null,
    );
  });

  it('does NOT report a correctly authored LoGeoRef-30 model', () => {
    // The safety control for #2534: site placement at the LOCAL origin, the
    // MapConversion carrying the single, legitimate offset. Nothing is
    // duplicated, so nothing may be corrected and nothing may be said.
    const info = coordInfoAt(12, -30);
    assert.strictEqual(
      effectiveMapConversionForGeometry(ISSUE_2526_CONVERSION, 1, info),
      ISSUE_2526_CONVERSION,
      'a LoGeoRef-30 file must keep its authored conversion',
    );
    assert.strictEqual(
      detectDoubleGeoreference(ISSUE_2526_CONVERSION, METRE_CRS, info, 0.001),
      null,
    );
  });

  it('does NOT report a correctly authored absolute-coordinate model (LoGeoRef 20)', () => {
    // Geometry at map coordinates, conversion is already the identity — there
    // is no second offset to drop.
    const identity: MapConversion = {
      ...ISSUE_2526_CONVERSION,
      eastings: 0,
      northings: 0,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
    };
    assert.strictEqual(
      detectDoubleGeoreference(identity, METRE_CRS, coordInfoAt(311988, 5996149), 0.001),
      null,
    );
  });

  it('does NOT report a map-sized model whose offset is an unrelated location', () => {
    // Same CRS, but the conversion points 400 km away: not a duplication.
    const elsewhere: MapConversion = { ...ISSUE_2526_CONVERSION, northings: 5596148.565 };
    assert.strictEqual(
      detectDoubleGeoreference(elsewhere, METRE_CRS, coordInfoAt(311988, 5996149), 0.001),
      null,
    );
  });

  it('tolerates a large-extent site (centre offset from the placement origin)', () => {
    // A 3 km-wide site puts its centre ~1.5 km from the site origin, well
    // inside the guard's window.
    const found = detectDoubleGeoreference(
      ISSUE_2526_CONVERSION,
      METRE_CRS,
      coordInfoAt(311988 + 1500, 5996149 + 1500),
      0.001,
    );
    assert.ok(found, 'expected the duplication to be caught despite the site extent');
  });

  it('scales millimetre MapConversion offsets before comparing', () => {
    // Same duplication expressed with a MILLIMETRE MapUnit: the offsets are
    // 1000× larger and only match the world centre after mapUnitScale.
    const mmConversion: MapConversion = {
      ...ISSUE_2526_CONVERSION,
      eastings: 311988180.54,
      northings: 5996148564.99,
    };
    const found = detectDoubleGeoreference(
      mmConversion,
      { mapUnitScale: 0.001 },
      coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y),
      0.001,
    );
    assert.ok(found, 'expected the mm-unit duplication to be caught');
    assert.ok(found!.residual < 1);
  });

  it('returns null without a conversion or without coordinate info', () => {
    assert.strictEqual(
      detectDoubleGeoreference(undefined, METRE_CRS, coordInfoAt(311988, 5996149), 0.001),
      null,
    );
    assert.strictEqual(
      detectDoubleGeoreference(ISSUE_2526_CONVERSION, METRE_CRS, undefined, 0.001),
      null,
    );
  });

  it('returns null for a non-finite offset, because the guard cannot fire on one', () => {
    const broken: MapConversion = { ...ISSUE_2526_CONVERSION, eastings: NaN };
    assert.strictEqual(
      effectiveMapConversionForGeometry(broken, 1, coordInfoAt(311988, 5996149)),
      broken,
    );
    assert.strictEqual(
      detectDoubleGeoreference(broken, METRE_CRS, coordInfoAt(311988, 5996149), 0.001),
      null,
    );
  });

  it('still reports a non-finite axis, quoting an unknown distance rather than going silent', () => {
    // The guard does not inspect the axis, so a malformed file IS still
    // corrected on screen and its authored axis IS still replaced. Suppressing
    // the note here would move the model and say nothing about it — the
    // failure mode this reconciliation exists to remove. Quote the uncertainty
    // instead.
    const info = coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y);
    for (const broken of [
      { ...ISSUE_2526_CONVERSION, xAxisAbscissa: NaN },
      { ...ISSUE_2526_CONVERSION, xAxisOrdinate: Number.POSITIVE_INFINITY },
    ] satisfies MapConversion[]) {
      assert.notStrictEqual(
        effectiveMapConversionForGeometry(broken, 1, info),
        broken,
        'precondition: the geometry guard still corrects a malformed-axis file',
      );
      const found = detectDoubleGeoreference(broken, METRE_CRS, info, 0.001);
      assert.ok(found, 'a corrected model must be explained even when malformed');
      assert.strictEqual(found!.overridesAuthoredRotation, true);
      assert.strictEqual(formatApproxDistance(found!.displacement), 'an unknown distance');
    }
  });

  it('still reports when Scale is NaN, because the effective scale resolves to 1', () => {
    // Not an oversight: getEffectiveHorizontalScale's unset/1 heuristic treats a
    // NaN Scale as "not provided" (NaN fails its `> 1e-9` test) and returns 1,
    // so the effective scale is well defined and the duplicated offsets are
    // still the real defect.
    const found = detectDoubleGeoreference(
      { ...ISSUE_2526_CONVERSION, scale: NaN },
      METRE_CRS,
      coordInfoAt(ISSUE_2526_CENTER.x, ISSUE_2526_CENTER.y),
      0.001,
    );
    assert.ok(found);
    assert.strictEqual(found!.overridesAuthoredScale, false);
    assert.ok(Number.isFinite(found!.displacement));
  });
});

describe('formatApproxDistance', () => {
  /**
   * Run `fn` with `Number.prototype.toLocaleString` behaving as it does in a
   * German browser — i.e. an UN-TAGGED call groups thousands with '.', while a
   * call that names its locale is honoured. This is the reporter's actual
   * environment on #2526.
   */
  function withGermanAmbientLocale(fn: () => void): void {
    const original = Number.prototype.toLocaleString;
    Number.prototype.toLocaleString = function (
      this: number,
      locales?: Intl.LocalesArgument,
      options?: Intl.NumberFormatOptions,
    ): string {
      return original.call(this, locales ?? 'de-DE', options);
    };
    try {
      fn();
    } finally {
      Number.prototype.toLocaleString = original;
    }
  }

  it('groups thousands in the language of the sentence, not the browser (#2526)', () => {
    withGermanAmbientLocale(() => {
      // The hazard, pinned: this is what an un-tagged toLocaleString() does on
      // the reporter's machine, and "displaced by about 6.004 km" inside an
      // English sentence reads as six metres.
      assert.strictEqual((6004).toLocaleString(), '6.004');
      assert.strictEqual(formatApproxDistance(6_004_291), 'about 6,004 km');
    });
  });

  it('groups the metre branch the same way', () => {
    withGermanAmbientLocale(() => {
      assert.strictEqual(formatApproxDistance(999.4), 'about 999 m');
    });
  });

  it('formats identically whatever the ambient locale is', () => {
    let underGerman = '';
    withGermanAmbientLocale(() => {
      underGerman = formatApproxDistance(6_004_291);
    });
    assert.strictEqual(underGerman, formatApproxDistance(6_004_291));
  });

  it('says what an unreadable magnitude implies instead of quoting it', () => {
    assert.strictEqual(formatApproxDistance(1e12), 'more than a planet-width');
    assert.strictEqual(formatApproxDistance(NaN), 'an unknown distance');
    assert.strictEqual(formatApproxDistance(Number.POSITIVE_INFINITY), 'an unknown distance');
  });
});
