/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  detectScaleUnitMismatch,
  getEffectiveHorizontalScale,
  hasStandardGeoreferencing,
  inferMapUnitScale,
  mergeMapConversion,
  mergeProjectedCRS,
  resolveEpsetMapUnitScale,
  supportsStandardGeoreferencing,
} from './effective-georef.js';
import { resolveMapUnitToMetreScale } from './geo-scale.js';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

describe('effective georeferencing', () => {
  it('recomputes map unit scale when the edited MapUnit changes', () => {
    const original: ProjectedCRS = {
      id: 1,
      name: 'EPSG:28992',
      mapUnit: 'METRE',
      mapUnitScale: 1,
    };

    const merged = mergeProjectedCRS(original, { mapUnit: 'US SURVEY FOOT' }, 1);

    assert.strictEqual(merged?.mapUnit, 'US SURVEY FOOT');
    assert.strictEqual(merged?.mapUnitScale, 0.3048006096);
  });

  it('preserves the extracted map unit scale when MapUnit was not edited', () => {
    const original: ProjectedCRS = {
      id: 1,
      name: 'EPSG:1234',
      mapUnit: 'CUSTOM',
      mapUnitScale: 2.5,
    };

    const merged = mergeProjectedCRS(original, { description: 'Edited CRS' }, 1);

    assert.strictEqual(merged?.description, 'Edited CRS');
    assert.strictEqual(merged?.mapUnitScale, 2.5);
  });

  /**
   * The MapUnit editor is a `<select>` whose first option has an empty value,
   * and `commitEdit` deliberately permits an empty commit for selects, so `''`
   * reaches `mergeProjectedCRS` as an edit.
   *
   * `''` is not `undefined`, so it took the EDITED branch and
   * `inferMapUnitScale('', lengthUnitScale)` returned the length-unit
   * fallback. That is exactly the reading `resolveMapUnitToMetreScale`'s doc
   * rejects -- "when no explicit MapUnit is set, treat the offsets as metres"
   * -- so clearing the field opted INTO the failure the heuristic exists to
   * avoid. For a millimetre project that is a 1000x under-scale of the CRS
   * offsets, which flings the model outside the CRS's valid range.
   */
  it('treats a CLEARED MapUnit as absent (metres), not as unparseable', () => {
    const original: ProjectedCRS = {
      id: 1,
      name: 'EPSG:28992',
      mapUnit: 'METRE',
      mapUnitScale: 1,
    };

    // lengthUnitScale 0.001 = a millimetre project, the case that hurts.
    const merged = mergeProjectedCRS(original, { mapUnit: '' }, 0.001);

    assert.strictEqual(merged?.mapUnit, '');
    // `undefined`, NOT the length-unit scale: an absent MapUnit leaves the
    // scale unresolved here and `resolveMapUnitToMetreScale` supplies the
    // metres default downstream. Asserting `1` here would be wrong -- that
    // number is produced one layer later, and pinning it in the wrong place
    // would pass for the wrong reason.
    assert.strictEqual(
      merged?.mapUnitScale,
      undefined,
      'a cleared MapUnit must be treated as absent, not as an unparseable unit',
    );
    // And the downstream resolution is the metres heuristic, which is the
    // behaviour the user actually gets.
    assert.strictEqual(resolveMapUnitToMetreScale(merged?.mapUnitScale, 0.001), 1);
  });

  it('still falls back to the length unit for a NON-EMPTY unparseable MapUnit', () => {
    // Control: the fix must not turn every edited MapUnit into 1, only the
    // cleared one. 'WIBBLE' matches no known unit, so the documented
    // length-unit fallback still applies.
    const original: ProjectedCRS = { id: 1, name: 'EPSG:28992', mapUnit: 'METRE', mapUnitScale: 1 };
    const merged = mergeProjectedCRS(original, { mapUnit: 'WIBBLE' }, 0.001);
    assert.strictEqual(merged?.mapUnitScale, 0.001);
  });

  it('treats IFC2X3 files with IfcMapConversion and IfcProjectedCRS as standard georeferencing', () => {
    assert.strictEqual(
      supportsStandardGeoreferencing('IFC2X3', {
        source: 'mapConversion',
        projectedCRS: {
          id: 1,
          name: 'EPSG:2056',
        },
        mapConversion: {
          id: 2,
          sourceCRS: 10,
          targetCRS: 11,
          eastings: 2681750,
          northings: 1225750,
          orthogonalHeight: 0,
        },
      }),
      true,
    );
  });

  it('treats IFC2X3 files with only IfcMapConversion (no IfcProjectedCRS name yet) as editable', () => {
    // Extension-bearing IFC2X3 files sometimes carry one half of the
    // georef pair; once we've parsed it, the editor should surface the
    // data instead of hiding behind a schema notice. See issue #683.
    assert.strictEqual(
      supportsStandardGeoreferencing('IFC2X3', {
        source: 'mapConversion',
        mapConversion: {
          id: 2,
          sourceCRS: 10,
          targetCRS: 11,
          eastings: 2681750,
          northings: 1225750,
          orthogonalHeight: 0,
        },
      }),
      true,
    );
  });

  it('treats IFC2X3 files with only IfcProjectedCRS as editable so users can add IfcMapConversion', () => {
    assert.strictEqual(
      supportsStandardGeoreferencing('IFC2X3', {
        projectedCRS: {
          id: 1,
          name: 'EPSG:2056',
        },
      }),
      true,
    );
  });

  it('keeps pure IfcSite IFC2X3 geolocation in read-only mode', () => {
    assert.strictEqual(
      supportsStandardGeoreferencing('IFC2X3', {
        source: 'siteLocation',
        projectedCRS: {
          id: 226,
          name: 'EPSG:4326',
        },
      }),
      false,
    );
  });

  it('falls back NaN eastings/northings/orthogonalHeight to 0 instead of poisoning downstream math (PR #1965 review)', () => {
    // A malformed IfcMapConversion or a bad mutation edit must not let a
    // NaN reach `resolveGeorefLinearParams`'s eastings/northings math, or
    // `hasStandardGeoreferencing`'s orthogonalHeight finiteness check --
    // `?? 0` alone passes NaN through untouched (NaN ?? 0 === NaN). The
    // maintainer's PR #1965 review flagged that the previous version of this
    // test asserted eastings/northings but never actually exercised
    // orthogonalHeight, even though the title claimed it did -- exercise it
    // for real here so a regression on that field fails this test.
    const original: MapConversion = {
      id: 2,
      sourceCRS: 10,
      targetCRS: 11,
      eastings: NaN,
      northings: 200,
      orthogonalHeight: NaN,
    };

    const merged = mergeMapConversion(original, { northings: NaN });

    assert.strictEqual(merged?.eastings, 0);
    assert.strictEqual(merged?.northings, 0);
    assert.strictEqual(merged?.orthogonalHeight, 0);
  });

  it('overlays edited IfcMapConversion fields without dropping original rotation and scale', () => {
    const original: MapConversion = {
      id: 2,
      sourceCRS: 10,
      targetCRS: 11,
      eastings: 100,
      northings: 200,
      orthogonalHeight: 5,
      xAxisAbscissa: 0,
      xAxisOrdinate: 1,
      scale: 0.9999,
    };

    const merged = mergeMapConversion(original, { eastings: 150, orthogonalHeight: 9 });

    assert.deepStrictEqual(merged, {
      id: 2,
      sourceCRS: 10,
      targetCRS: 11,
      eastings: 150,
      northings: 200,
      orthogonalHeight: 9,
      xAxisAbscissa: 0,
      xAxisOrdinate: 1,
      scale: 0.9999,
    });
  });

  describe('resolveEpsetMapUnitScale (IFC2x3 ePset offsets use the project unit)', () => {
    it('defaults an ePSet georef without MapUnit to the project length-unit scale', () => {
      // mm project (lengthUnitScale = 0.001): RD offsets are authored in mm and
      // must scale by 0.001 to metres, NOT pass through the "treat as metres"
      // heuristic that would put the model 1000× out of range.
      assert.strictEqual(resolveEpsetMapUnitScale('ePSetMapConversion', undefined, 0.001), 0.001);
    });

    it('keeps an explicit MapUnit scale on an ePSet georef (user edited MapUnit)', () => {
      assert.strictEqual(resolveEpsetMapUnitScale('ePSetMapConversion', 1, 0.001), 1);
    });

    it('leaves native IfcMapConversion georef untouched', () => {
      assert.strictEqual(resolveEpsetMapUnitScale('mapConversion', undefined, 0.001), undefined);
    });

    it('leaves siteLocation georef untouched', () => {
      assert.strictEqual(resolveEpsetMapUnitScale('siteLocation', undefined, 0.001), undefined);
    });

    /**
     * `getEffectiveGeoreference` calls `mergeProjectedCRS` then
     * `resolveEpsetMapUnitScale` in sequence (this file's `getEffectiveGeoreference`,
     * around the `resolveEpsetMapUnitScale(original?.source, ...)` call). Every
     * consumer that builds its CRS this way -- ViewportContainer, BasepointOverlay,
     * FederationAlignmentControls, federationAlign.ts, useAnchorGeoreference.ts --
     * gets the corrected scale.
     *
     * `GeoreferencingPanel.tsx` used to call `mergeProjectedCRS` ALONE (its
     * `georef` prop comes from `ModelMetadataPanel.tsx`'s own
     * `extractGeoreferencingOnDemand` call, not `getEffectiveGeoreference`), so
     * for an ePSet_MapConversion IFC2x3 file with no explicit ePset MapUnit its
     * `mergedCRS.mapUnitScale` stayed `undefined` -- which
     * `resolveMapUnitToMetreScale` reads as "treat offsets as metres" (scale 1)
     * instead of the project length-unit scale. For a millimetre project that
     * fed `detectDoubleGeoreference` an easting/northing 1000x too large.
     * Pinning the two-step composition here so a regression in either function
     * -- or a caller that goes back to calling `mergeProjectedCRS` alone --
     * shows up.
     */
    it('mergeProjectedCRS + resolveEpsetMapUnitScale composition matches getEffectiveGeoreference (GeoreferencingPanel parity)', () => {
      const original: ProjectedCRS = {
        id: 1,
        name: 'RD_New',
        mapUnit: undefined,
        mapUnitScale: undefined,
      };
      const lengthUnitScale = 0.001; // millimetre project

      const merged = mergeProjectedCRS(original, undefined, lengthUnitScale);
      const scaleWithoutFix = resolveMapUnitToMetreScale(merged?.mapUnitScale, lengthUnitScale);
      assert.strictEqual(scaleWithoutFix, 1, 'sanity: mergeProjectedCRS alone leaves the ePSet gap open');

      const correctedMapUnitScale = resolveEpsetMapUnitScale('ePSetMapConversion', merged?.mapUnitScale, lengthUnitScale);
      const scaleWithFix = resolveMapUnitToMetreScale(correctedMapUnitScale, lengthUnitScale);
      assert.strictEqual(scaleWithFix, lengthUnitScale, 'the composed scale must match every other consumer');
    });
  });

  it('infers common IFC map unit names', () => {
    assert.strictEqual(inferMapUnitScale('FOOT'), 0.3048);
    assert.strictEqual(inferMapUnitScale('METRE'), 1);
    assert.strictEqual(inferMapUnitScale('MILLIMETRE'), 0.001);
  });

  describe('getEffectiveHorizontalScale (issue #595)', () => {
    it('returns 1 when project mm and map m, with Scale=0.001 (Bonsai-style)', () => {
      // mm project (lengthUnitScale=0.001), m map (mapUnitScale=1), Scale=0.001
      assert.strictEqual(getEffectiveHorizontalScale(0.001, 1, 0.001), 1);
    });

    it('returns 1 when project m and map m, with Scale=1', () => {
      assert.strictEqual(getEffectiveHorizontalScale(1, 1, 1), 1);
    });

    it('returns 1 when project ft and map m, with Scale=0.3048', () => {
      assert.strictEqual(getEffectiveHorizontalScale(0.3048, 1, 0.3048), 1);
    });

    it('returns 1 when project mm and map mm, with Scale=1 (consistent units)', () => {
      assert.strictEqual(getEffectiveHorizontalScale(1, 0.001, 0.001), 1);
    });

    it('preserves a deliberate non-unit scaling (Scale=2 with metres throughout)', () => {
      assert.strictEqual(getEffectiveHorizontalScale(2, 1, 1), 2);
    });

    it('treats Scale=undefined + unit mismatch as author-meant-Scale=1/lus (Bonsai heuristic)', () => {
      // Project mm, map m, Scale undefined. Spec-strict effective = 1 * 1 /
      // 0.001 = 1000 would inflate metre-converted geometry 1000x, pushing
      // proj4 inputs miles outside the CRS valid range — the model lands at
      // the projection's antipode (Hans's IXAS_KW 018_georeffed.ifc bug).
      // Bonsai/IfcOpenShell/Revit exports routinely omit Scale; the author's
      // intent is "geometry and offsets share the same metric unit", which
      // corresponds to Scale=lengthUnitScale/mapUnitScale per spec → effective 1.
      assert.strictEqual(getEffectiveHorizontalScale(undefined, 1, 0.001), 1);
    });

    it('treats Scale=1 + unit mismatch the same as Scale=undefined (heuristic also fires)', () => {
      // Same situation as above, but the file wrote Scale=1 explicitly (also
      // common — Revit's IFC exporter does this). The heuristic must catch
      // both the missing-Scale and the wrong-Scale=1 cases.
      assert.strictEqual(getEffectiveHorizontalScale(1, 1, 0.001), 1);
    });

    it('preserves spec-strict math when Scale ≠ 1 (the author opted in to a real scaling)', () => {
      // Scale=2 with mm project + m map says "multiply X_local by 2 when
      // adding to map offsets" — deliberate, not a unit-bridging mistake.
      // Effective = (2 * 1) / 0.001 = 2000.
      assert.strictEqual(getEffectiveHorizontalScale(2, 1, 0.001), 2000);
    });

    it('falls back to 1 for non-positive lengthUnitScale or mapUnitScale', () => {
      assert.strictEqual(getEffectiveHorizontalScale(1, 0, 1), 1);
      assert.strictEqual(getEffectiveHorizontalScale(1, 1, 0), 1);
      assert.strictEqual(getEffectiveHorizontalScale(1, -1, 1), 1);
    });
  });

  describe('detectScaleUnitMismatch', () => {
    it('returns null for spec-compliant Scale (mm/m with Scale=0.001)', () => {
      assert.strictEqual(detectScaleUnitMismatch(0.001, 1, 0.001), null);
    });

    it('returns null when project=map=metres and Scale=1', () => {
      assert.strictEqual(detectScaleUnitMismatch(1, 1, 1), null);
    });

    it('returns null when project=map=metres and Scale is undefined', () => {
      assert.strictEqual(detectScaleUnitMismatch(undefined, 1, 1), null);
    });

    it('flags the common Scale=1 + mm-project + m-map error as COMPENSATED', () => {
      // The file is off-spec, but `getEffectiveHorizontalScale`'s unset/1 Scale
      // heuristic already places the geometry at 1×. Reporting effectiveScale
      // 1000 here claimed a mis-sizing the code prevents, and that false
      // warning was the only thing the panel said about the #2526 file.
      const m = detectScaleUnitMismatch(1, 1, 0.001);
      assert.ok(m, 'expected a mismatch report');
      assert.strictEqual(m!.rawScale, 1);
      assert.strictEqual(m!.specEffectiveScale, 1000);
      assert.strictEqual(m!.effectiveScale, 1);
      assert.strictEqual(m!.compensated, true);
      assert.strictEqual(m!.expectedScale, 0.001);
    });

    it('flags Scale omitted when units differ as COMPENSATED', () => {
      const m = detectScaleUnitMismatch(undefined, 1, 0.001);
      assert.ok(m);
      assert.strictEqual(m!.specEffectiveScale, 1000);
      assert.strictEqual(m!.effectiveScale, 1);
      assert.strictEqual(m!.compensated, true);
    });

    it('does NOT mark a genuine mis-scaling as compensated', () => {
      // Scale explicitly 1000 on a mm project: the heuristic only rescues an
      // unset/1 Scale, so this really is applied and really does mis-size.
      const m = detectScaleUnitMismatch(1000, 1, 0.001);
      assert.ok(m);
      assert.strictEqual(m!.effectiveScale, 1e6);
      assert.strictEqual(m!.specEffectiveScale, 1e6);
      assert.strictEqual(m!.compensated, false);
    });

    it('tolerates tiny floating-point noise around 1.0', () => {
      // Scale = 1.0 ± 0.4% should still be considered consistent.
      assert.strictEqual(detectScaleUnitMismatch(1.004, 1, 1), null);
      assert.strictEqual(detectScaleUnitMismatch(0.996, 1, 1), null);
    });

    it('flags a deliberate non-unit scaling (Scale=2 with metres)', () => {
      const m = detectScaleUnitMismatch(2, 1, 1);
      assert.ok(m);
      assert.strictEqual(m!.effectiveScale, 2);
      assert.strictEqual(m!.compensated, false);
    });
  });

  describe('hasStandardGeoreferencing (federation alignment gate)', () => {
    // Federation affine alignment (extractModelGeoref → buildGeorefAlignmentTransform)
    // gates on this predicate. A site-location-only georef must NOT qualify: it is
    // EPSG:4326 lat/long degrees + a raw, un-unit-scaled IfcSite RefElevation, which
    // the projected-CRS transform misreads as metres and flings the second federated
    // model kilometres away. These tests lock that invariant.
    const mapConversion: MapConversion = {
      id: 1,
      sourceCRS: 0,
      targetCRS: 0,
      eastings: 100,
      northings: 200,
      orthogonalHeight: 5,
    };

    it('rejects synthesised site-location georef even with a CRS name + map conversion', () => {
      assert.strictEqual(
        hasStandardGeoreferencing({
          source: 'siteLocation',
          projectedCRS: { id: 1, name: 'EPSG:4326' },
          mapConversion,
        }),
        false,
      );
    });

    it('accepts true IfcMapConversion + IfcProjectedCRS georef', () => {
      assert.strictEqual(
        hasStandardGeoreferencing({
          source: 'mapConversion',
          projectedCRS: { id: 1, name: 'EPSG:28992' },
          mapConversion,
        }),
        true,
      );
    });

    it('accepts IFC2x3 ePSet_MapConversion georef (enables Cesium / federation)', () => {
      // The buildingSMART IFC2x3 ePset fallback is a real projected placement
      // (RD eastings/northings), unlike the lat/long-only siteLocation path —
      // it must pass the same gate as native IfcMapConversion so the model
      // reaches the Cesium overlay and federation alignment.
      assert.strictEqual(
        hasStandardGeoreferencing({
          source: 'ePSetMapConversion',
          projectedCRS: { id: 1, name: 'EPSG:7415' },
          mapConversion,
        }),
        true,
      );
    });

    it('rejects georef missing a map conversion', () => {
      assert.strictEqual(
        hasStandardGeoreferencing({
          source: 'mapConversion',
          projectedCRS: { id: 1, name: 'EPSG:28992' },
          mapConversion: undefined,
        }),
        false,
      );
    });

    it('rejects georef missing a projected CRS name', () => {
      assert.strictEqual(
        hasStandardGeoreferencing({
          source: 'mapConversion',
          projectedCRS: { id: 1, name: '' },
          mapConversion,
        }),
        false,
      );
    });

    it('rejects null / undefined', () => {
      assert.strictEqual(hasStandardGeoreferencing(null), false);
      assert.strictEqual(hasStandardGeoreferencing(undefined), false);
    });

    it('rejects a mapConversion with non-finite eastings or northings (PR #1965 review, NaN guard)', () => {
      assert.strictEqual(
        hasStandardGeoreferencing({
          source: 'mapConversion',
          projectedCRS: { id: 1, name: 'EPSG:28992' },
          mapConversion: { ...mapConversion, eastings: NaN },
        }),
        false,
      );
      assert.strictEqual(
        hasStandardGeoreferencing({
          source: 'mapConversion',
          projectedCRS: { id: 1, name: 'EPSG:28992' },
          mapConversion: { ...mapConversion, northings: Infinity },
        }),
        false,
      );
    });

    it('rejects a mapConversion with non-finite orthogonalHeight (PR #1965 review round 2, NaN guard)', () => {
      // The finiteness check previously stopped at eastings/northings.
      // `hasUsableMapGeoref` (pick-to-geo.ts) delegates here for the XYZ
      // readout, which adds `mapConversion.orthogonalHeight` straight into
      // the returned height with no fallback -- a NaN here must be rejected
      // at this gate exactly like a NaN eastings/northings is, or it lands
      // directly in Z.
      assert.strictEqual(
        hasStandardGeoreferencing({
          source: 'mapConversion',
          projectedCRS: { id: 1, name: 'EPSG:28992' },
          mapConversion: { ...mapConversion, orthogonalHeight: NaN },
        }),
        false,
      );
    });

    it('accepts a mapConversion with non-finite Scale or axis components (deliberate, not a gap)', () => {
      // Unlike orthogonalHeight, Scale and the XAxisAbscissa/XAxisOrdinate
      // axis pair are NOT part of this gate's finiteness check. The DXF
      // export/underlay path's `resolveGeorefLinearParams`
      // (dxfExportGeoref.ts) already substitutes finite fallbacks for
      // exactly this case (Scale=0/NaN → 1, degenerate/non-finite axis →
      // (1, 0)) so a malformed Scale/axis still renders the DXF underlay
      // somewhere. `selectAnchorGeoref` gates anchor selection through this
      // same predicate, so rejecting non-finite Scale/axis here would reject
      // that model as an anchor before the fallback ever runs -- turning a
      // georeference that currently renders (via the fallback) into one
      // that's silently disabled. This test locks that the gate stays
      // permissive for these two fields.
      assert.strictEqual(
        hasStandardGeoreferencing({
          source: 'mapConversion',
          projectedCRS: { id: 1, name: 'EPSG:28992' },
          mapConversion: { ...mapConversion, scale: NaN, xAxisAbscissa: NaN, xAxisOrdinate: Infinity },
        }),
        true,
      );
    });
  });
});
