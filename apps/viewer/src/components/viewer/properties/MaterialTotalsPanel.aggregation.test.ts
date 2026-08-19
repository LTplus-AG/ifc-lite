/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `pickQuantity`'s docstring on `MaterialTotalsPanel` promises: "Pick a
 * quantity value by candidate names (case-insensitive), else by type." The
 * volume call site implemented that fallback; the area and weight call
 * sites — built from the same `*ByName` maps in the same `qset.quantities`
 * loop — did not. An element whose only area (or weight) quantity carries a
 * vendor-specific name outside the IFC-standard candidate list (e.g.
 * "PerimeterArea", "TopArea") contributed zero to that material's total and
 * its row was hidden, while the identical situation for volume was counted.
 * This has been present since the file's first commit (#978).
 *
 * These tests drive `aggregateQuantitiesFromQsets` — the function extracted
 * from the three call sites so the "match a candidate name, else by type"
 * rule is applied identically to volume, area and weight instead of three
 * copies that can silently drift apart.
 *
 * PR #2777 review 1 (louistrue): proved on the app's own shipped sample
 * (`apps/viewer/public/samples/infra-bridge.ifc`) that the alphabetical
 * by-type fallback picks a beam's `CrossSectionArea` — a section property,
 * not a surface extent — as its Area, because no candidate name matched and
 * `crosssectionarea` sorts before the beam's other (non-candidate) area
 * names. Review 2: the fix is `AREA_CANDIDATES` recognising the standard
 * surface-area names by NAME (so beams/columns/members resolve without ever
 * reaching the fallback) plus `AREA_TYPE_FALLBACK_DENY` excluding
 * `crosssectionarea` from the fallback itself, so it can never be selected
 * even as a last resort.
 *
 * Review 1's MAJOR finding: every fixture in the original suite held exactly
 * one quantity of the kind under test, so the candidate-match path and the
 * type-fallback path returned the same value — deleting the candidate
 * matching entirely (`for (const c of candidates) ...` -> `void candidates;`)
 * left all 10 tests green. The "candidate wins over fallback" and
 * "case-insensitive match" tests below use TWO quantities per fixture, one
 * that only the candidate-priority / case-insensitive path picks correctly
 * and one that the (deny-filtered) alphabetical fallback would pick instead
 * if matching were skipped — see the mutation notes on each test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuantityType } from '@ifc-lite/data';
import { aggregateQuantitiesFromQsets } from './MaterialTotalsPanel.js';

type Qty = { name: string; type: number; value: number };
type Qset = { quantities: readonly Qty[] };

function qsets(quantities: Qty[]): Qset[] {
  return [{ quantities }];
}

describe('aggregateQuantitiesFromQsets', () => {
  describe('volume', () => {
    it('picks a candidate-named quantity (existing behaviour)', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetVolume', type: QuantityType.Volume, value: 12 }]),
      );
      assert.equal(r.volume, 12);
    });

    it('falls back to a non-candidate-named quantity of the same type (the fix)', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'CustomVendorVolume', type: QuantityType.Volume, value: 7 }]),
      );
      assert.equal(r.volume, 7);
    });

    it('is undefined when no volume quantity exists', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetArea', type: QuantityType.Area, value: 5 }]),
      );
      assert.equal(r.volume, undefined);
    });
  });

  describe('area', () => {
    it('picks a candidate-named quantity (existing behaviour)', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetArea', type: QuantityType.Area, value: 30 }]),
      );
      assert.equal(r.area, 30);
    });

    it('falls back to a non-candidate-named quantity of the same type (the fix)', () => {
      // RED against pre-fix code: the area call site had no else-by-type
      // fallback, so this returned undefined and the total stayed 0.
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'PerimeterArea', type: QuantityType.Area, value: 18 }]),
      );
      assert.equal(r.area, 18);
    });

    it('is undefined when no area quantity exists', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetVolume', type: QuantityType.Volume, value: 9 }]),
      );
      assert.equal(r.area, undefined);
    });
  });

  describe('weight', () => {
    it('picks a candidate-named quantity (existing behaviour)', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetWeight', type: QuantityType.Weight, value: 500 }]),
      );
      assert.equal(r.weight, 500);
    });

    it('falls back to a non-candidate-named quantity of the same type (the fix)', () => {
      // RED against pre-fix code: the weight call site had no else-by-type
      // fallback, so this returned undefined and the total stayed 0.
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'ShippingWeight', type: QuantityType.Weight, value: 250 }]),
      );
      assert.equal(r.weight, 250);
    });

    it('is undefined when no weight quantity exists', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetArea', type: QuantityType.Area, value: 4 }]),
      );
      assert.equal(r.weight, undefined);
    });
  });

  it('breaks ties among several non-candidate names deterministically (alphabetical)', () => {
    const r = aggregateQuantitiesFromQsets(
      qsets([
        { name: 'ZTopArea', type: QuantityType.Area, value: 99 },
        { name: 'APerimeterArea', type: QuantityType.Area, value: 11 },
      ]),
    );
    assert.equal(r.area, 11);
  });

  describe('CrossSectionArea must never be reported as a surface Area (PR #2777 review 1)', () => {
    it('is undefined when the only area quantity is CrossSectionArea (infra-bridge.ifc beam shape)', () => {
      // Real shape of apps/viewer/public/samples/infra-bridge.ifc's
      // Qto_BeamBaseQuantities (#385/#442/#493): NetVolume, Length,
      // CrossSectionArea — no surface-area quantity at all. Before this
      // fix, the alphabetical fallback had exactly one Area-typed name to
      // choose from and picked it, reporting 0.12 m2 (the beam's profile
      // area) as the material's surface area. Absence is the honest result.
      const r = aggregateQuantitiesFromQsets(
        qsets([
          { name: 'NetVolume', type: QuantityType.Volume, value: 0.48 },
          { name: 'Length', type: QuantityType.Length, value: 4000 },
          { name: 'CrossSectionArea', type: QuantityType.Area, value: 0.12 },
        ]),
      );
      assert.equal(r.area, undefined);
    });

    it('picks a real surface-area quantity over CrossSectionArea by name (the requested beam fixture)', () => {
      // The exact fixture louistrue's second review asked for: "a beam
      // carrying CrossSectionArea AND OuterSurfaceArea, asserting the
      // surface area is chosen." outersurfacearea is now in
      // AREA_CANDIDATES, so this resolves by name and never reaches the
      // fallback at all.
      const r = aggregateQuantitiesFromQsets(
        qsets([
          { name: 'CrossSectionArea', type: QuantityType.Area, value: 0.06 },
          { name: 'OuterSurfaceArea', type: QuantityType.Area, value: 11.9 },
        ]),
      );
      assert.equal(r.area, 11.9);
    });

    it('excludes CrossSectionArea from the by-type fallback even when a non-candidate name is also present', () => {
      // Neither name matches AREA_CANDIDATES, so this exercises the
      // fallback path (not name matching). MUTATION: delete
      // AREA_TYPE_FALLBACK_DENY (or stop passing it to pickQuantity) and
      // this goes RED — alphabetical sort puts 'crosssectionarea' before
      // 'vendorsurfacearea', returning 0.06 instead of 11.9.
      const r = aggregateQuantitiesFromQsets(
        qsets([
          { name: 'CrossSectionArea', type: QuantityType.Area, value: 0.06 },
          { name: 'VendorSurfaceArea', type: QuantityType.Area, value: 11.9 },
        ]),
      );
      assert.equal(r.area, 11.9);
    });
  });

  describe('candidate priority is load-bearing, not incidental (PR #2777 review 1 MAJOR finding)', () => {
    it('prefers Net over Gross even though Gross sorts first alphabetically', () => {
      // MUTATION: delete the candidate-matching loop in pickQuantity
      // (`for (const c of candidates) ...` -> `void candidates;`) and this
      // goes RED — with matching skipped, both fixtures fall straight to
      // the alphabetical fallback, which prefers 'grossarea' (13) over
      // 'netarea' (7) purely by spelling. Every fixture in the original
      // suite held one quantity per kind, so this priority was unguarded:
      // the candidate path and the fallback path always agreed.
      const r = aggregateQuantitiesFromQsets(
        qsets([
          { name: 'GrossArea', type: QuantityType.Area, value: 13 },
          { name: 'NetArea', type: QuantityType.Area, value: 7 },
        ]),
      );
      assert.equal(r.area, 7);
    });

    it('matches candidate names case-insensitively even when a differently-cased fallback name would sort first', () => {
      // MUTATION: change `q.name.toLowerCase()` to `q.name` in
      // aggregateQuantitiesFromQsets and this goes RED — the map key stays
      // 'NETAREA' (uppercase), which no longer matches the lowercase
      // candidate 'netarea', so it falls to the alphabetical fallback.
      // Case-sensitive sort puts 'AVendorArea' (5000) before 'NETAREA'
      // (10), returning the wrong value.
      const r = aggregateQuantitiesFromQsets(
        qsets([
          { name: 'NETAREA', type: QuantityType.Area, value: 10 },
          { name: 'AVendorArea', type: QuantityType.Area, value: 5000 },
        ]),
      );
      assert.equal(r.area, 10);
    });
  });
});
