/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-parity guard for `BUILDING_ELEMENT_TYPES` (see #3480, which found
 * and flagged this set as an awareness item while fixing the analogous
 * `FEATURE_ELEMENT_TYPES` gap in `@ifc-lite/drawing-2d`).
 *
 * `BUILDING_ELEMENT_TYPES` was a 15-name hand list, unused anywhere in this
 * package at the time of the fix but exported as public API (`export *` in
 * `index.ts`), so any external consumer of `@ifc-lite/ifcx` calling it a
 * membership test for "physical building element" got a set missing at
 * least `IfcFooting`, `IfcPile`, `IfcMember`, `IfcPlate`,
 * `IfcShadingDevice`, `IfcChimney`, `IfcStairFlight`, `IfcRampFlight` for
 * IFC4 alone, `IfcDoorStandardCase`/`IfcWindowStandardCase` on top of that,
 * and every IFC4X3 civil/infrastructure addition (`IfcBearing`,
 * `IfcCaissonFoundation`, `IfcCourse`, `IfcDeepFoundation`,
 * `IfcEarthworksFill`, `IfcKerb`, `IfcMooringDevice`,
 * `IfcNavigationElement`, `IfcPavement`, `IfcRail`, `IfcReinforcedSoil`,
 * `IfcTrackElement`) — IFC4X3 replaced the family root `IfcBuildingElement`
 * with `IfcBuiltElement`, so even a schema-derived walk rooted only at the
 * IFC4 name would silently return nothing for IFC4X3. Unlike the abstract
 * IFC2X3/IFC4 root, `IfcBuiltElement` is itself concrete, so it has to be
 * a member of the set and not merely the walk's starting point.
 *
 * This test re-derives the full descendant set from `@ifc-lite/data`'s
 * generated IFC2X3/IFC4/IFC4X3 entity tables — walking `IfcBuildingElement`
 * for IFC2X3/IFC4 and `IfcBuiltElement` for IFC4X3 — and asserts
 * `BUILDING_ELEMENT_TYPES` agrees in both directions: every member of each
 * schema's universe is in the set, and every name in the set is in the union
 * of the three universes. So neither a future schema bump nor a hand-edit can
 * quietly reopen the gap or slip an unrelated class in.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import type { IfcEntityInfo } from '@ifc-lite/data';
import { BUILDING_ELEMENT_TYPES } from './types.js';

/**
 * Every descendant of `root` (plus the root itself) in one schema.
 *
 * Deliberately a second copy of the walk in `types.ts` rather than an import
 * of it: an oracle that shares the code under test cannot disagree with it,
 * and this file's whole job is to disagree when the set drifts.
 */
function elementUniverse(entities: readonly IfcEntityInfo[], root: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const entity of entities) {
    if (!entity.parent) continue;
    const siblings = children.get(entity.parent) ?? [];
    siblings.push(entity.name);
    children.set(entity.parent, siblings);
  }
  const out = new Set<string>([root]);
  const walk = (node: string): void => {
    for (const child of children.get(node) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

const SCHEMAS: ReadonlyArray<
  readonly [name: string, entities: readonly IfcEntityInfo[], root: string]
> = [
  ['IFC2X3', ENTITIES_IFC2X3, 'IfcBuildingElement'],
  ['IFC4', ENTITIES_IFC4, 'IfcBuildingElement'],
  ['IFC4X3', ENTITIES_IFC4X3, 'IfcBuiltElement'],
];

describe('BUILDING_ELEMENT_TYPES vs generated IFC schemas', () => {
  for (const [schemaName, entities, root] of SCHEMAS) {
    const universe = elementUniverse(entities, root);

    it(`derives a non-trivial ${root} universe from ${schemaName} (anti-vacuity)`, () => {
      // If the parent walk broke or the root name is wrong for this schema
      // (as a naive walk of only 'IfcBuildingElement' would be for
      // IFC4X3), `universe` collapses to just the root and every assertion
      // below passes vacuously.
      assert.ok(universe.size > 1, `expected a real ${root} family, got size ${universe.size}`);
    });

    it(`BUILDING_ELEMENT_TYPES flags every ${schemaName} ${root} member`, () => {
      // The root counts as a member, not just the walk's starting point:
      // excluding it drops IFC4X3's concrete `IfcBuiltElement` (see the
      // dedicated case below).
      const missing = [...universe].filter((name) => !BUILDING_ELEMENT_TYPES.has(name));
      assert.deepStrictEqual(missing, []);
    });
  }

  it('carries no name outside the union of the three schema universes', () => {
    // The other direction, and the one a per-schema subset check is blind to:
    // a name hand-added to the set literal, or a root accidentally widened to
    // `IfcElement`, leaves every `missing` list empty and would otherwise sail
    // through. Modelled on spatial-types-authority.test.ts, which asserts
    // `missing` and `extra` together for `SPATIAL_TYPES`.
    //
    // The comparison is against the union and not against any single schema,
    // because the set spans all three: `IfcDoorStandardCase` is an IFC4 name
    // IFC4X3 dropped, `IfcBearing` an IFC4X3 name IFC4 never had, and both
    // belong in the set. Run per schema, this check would reject each of them.
    // The two directions also cross-guard each other's arithmetic — a union
    // computed too wide here shows up as a non-empty `missing` above.
    const union = new Set(
      SCHEMAS.flatMap(([, entities, root]) => [...elementUniverse(entities, root)]),
    );
    const extra = [...BUILDING_ELEMENT_TYPES].filter((name) => !union.has(name));
    assert.deepStrictEqual(extra, []);
  });

  it('names the specific IFC4 gap reported for this set', () => {
    for (const name of [
      'IfcFooting',
      'IfcPile',
      'IfcMember',
      'IfcPlate',
      'IfcShadingDevice',
      'IfcChimney',
      'IfcStairFlight',
      'IfcRampFlight',
    ]) {
      assert.ok(BUILDING_ELEMENT_TYPES.has(name), `${name} missing from BUILDING_ELEMENT_TYPES`);
    }
  });

  it('names the IFC4X3-only civil/infrastructure additions under the renamed root', () => {
    for (const name of [
      'IfcBearing',
      'IfcCaissonFoundation',
      'IfcCourse',
      'IfcDeepFoundation',
      'IfcEarthworksFill',
      'IfcKerb',
      'IfcMooringDevice',
      'IfcNavigationElement',
      'IfcPavement',
      'IfcRail',
      'IfcReinforcedSoil',
      'IfcTrackElement',
    ]) {
      assert.ok(BUILDING_ELEMENT_TYPES.has(name), `${name} missing from BUILDING_ELEMENT_TYPES`);
    }
  });

  it('carries IFC4X3 IfcBuiltElement itself, which the schema marks concrete', () => {
    // The one root that is instantiable: an IFC4X3 file may carry an
    // `IFCBUILTELEMENT` line, so a set that walks from the root but drops
    // it answers `false` for a real built element. Read the flag from the
    // generated table rather than asserting it here, so a future schema
    // that makes the root abstract shows up as a failure to re-decide
    // rather than as a stale hand-written claim.
    const root = ENTITIES_IFC4X3.find((entity) => entity.name === 'IfcBuiltElement');
    assert.ok(root, 'IfcBuiltElement missing from ENTITIES_IFC4X3');
    assert.strictEqual(root.abstract, false, 'IfcBuiltElement is no longer concrete in IFC4X3');
    assert.ok(
      BUILDING_ELEMENT_TYPES.has('IfcBuiltElement'),
      'IfcBuiltElement missing from BUILDING_ELEMENT_TYPES',
    );
  });

  it('does not flag any real IfcElement outside the building-element family (IFC4)', () => {
    // Negative control: a spatial/feature/distribution class wrongly inside
    // the set would make it useless as a "is this a physical building
    // element" test. IfcOpeningElement in particular was in the pre-fix
    // hand list even though it descends from IfcFeatureElement, not
    // IfcBuildingElement — it is a subtraction feature, not structure.
    for (const name of [
      'IfcProject',
      'IfcSite',
      'IfcBuilding',
      'IfcBuildingStorey',
      'IfcSpace',
      'IfcOpeningElement',
      'IfcFurnishingElement',
      'IfcDistributionElement',
      'IfcFlowSegment',
    ]) {
      assert.ok(!BUILDING_ELEMENT_TYPES.has(name), `${name} must not be a building element`);
    }
  });
});
