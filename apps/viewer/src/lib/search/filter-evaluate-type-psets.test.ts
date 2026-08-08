/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Search filter must see TYPE-inherited property sets, the way the
 * Properties panel already shows them (`extractTypePropertiesOnDemand`,
 * `PropertiesPanel.tsx`'s "inherited type properties" section) — the bug
 * this covers is `Pset_WallCommon.IsExternal = true` not matching a wall
 * whose `IsExternal` is only defined on its `IfcWallType`.
 *
 * Fixture (real STEP text parsed through the WASM-less columnar parser,
 * `IfcParser.parseColumnar`, so `extractTypePropertiesOnDemand`'s
 * source-backed path is genuinely exercised, not mocked):
 *
 *  - Wall-A (#100): OWN `Pset_WallCommon` with `Reference = 'INSTANCE-REF'`.
 *    No own `IsExternal`. Its type (#200, IfcWallType "WT-Std") carries
 *    `Pset_WallCommon` with `IsExternal = true` AND `Reference = 'TYPE-REF'`
 *    — the SAME property name as the instance, so Wall-A pins the
 *    instance-wins precedence rule (IFC: occurrence overrides type).
 *  - Wall-B (#110): NO own property sets at all — every property it
 *    exposes comes from the type. Pins pure type-only visibility.
 *  - Door-C (#120): no relations, no psets anywhere — the "neither"
 *    bounding control.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import { Rule } from './filter-rules.js';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#100=IFCWALL('Wall00000000000000001A',$,'Wall-A',$,$,$,$,$,.SOLIDWALL.);
#110=IFCWALL('Wall00000000000000001B',$,'Wall-B',$,$,$,$,$,.SOLIDWALL.);
#120=IFCDOOR('Door000000000000000001C',$,'Door-C',$,$,$,$,$,$);
#200=IFCWALLTYPE('Type00000000000000001A',$,'WT-Std',$,$,(#210),$,$,$,.STANDARD.);
#210=IFCPROPERTYSET('Pset00000000000000001A',$,'Pset_WallCommon',$,(#211,#212));
#211=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#212=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('TYPE-REF'),$);
#230=IFCRELDEFINESBYTYPE('Rdbt00000000000000001A',$,$,$,(#100,#110),#200);
#250=IFCPROPERTYSET('Pset00000000000000002A',$,'Pset_WallCommon',$,(#251));
#251=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('INSTANCE-REF'),$);
#260=IFCRELDEFINESBYPROPERTIES('Rdbp00000000000000001A',$,$,$,(#100),#250);
ENDSEC;
END-ISO-10303-21;
`;

async function buildStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(FIXTURE);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true }) as unknown as Promise<IfcDataStore>;
}

describe('evaluateFilterRules — TYPE-inherited property sets', () => {
  it('matches a property that exists ONLY on the type (Wall-A and Wall-B both inherit IsExternal)', async () => {
    const store = await buildStore();
    const out = evaluateFilterRules('m1', store, [
      Rule.property('Pset_WallCommon', 'IsExternal', 'eq', 'true'),
    ], 'AND');
    assert.deepStrictEqual(out.map((r) => r.expressId).sort((a, b) => a - b), [100, 110]);
  });

  it('PRECEDENCE: instance value wins over type value for the same property name', async () => {
    const store = await buildStore();

    // Wall-A's OWN Reference ('INSTANCE-REF') must win over its type's
    // Reference ('TYPE-REF') — only Wall-A matches, not Wall-B (whose
    // Reference comes solely from the type and is 'TYPE-REF').
    const instanceMatch = evaluateFilterRules('m1', store, [
      Rule.property('Pset_WallCommon', 'Reference', 'eq', 'INSTANCE-REF'),
    ], 'AND');
    assert.deepStrictEqual(instanceMatch.map((r) => r.expressId), [100]);

    // The type's own value must NOT leak through for Wall-A (it's shadowed
    // by the instance override) — only Wall-B, which has no instance
    // override, matches 'TYPE-REF'.
    const typeValueMatch = evaluateFilterRules('m1', store, [
      Rule.property('Pset_WallCommon', 'Reference', 'eq', 'TYPE-REF'),
    ], 'AND');
    assert.deepStrictEqual(typeValueMatch.map((r) => r.expressId), [110]);
  });

  it('BOUNDING CONTROL (i): an instance-level-only property still matches exactly as before', async () => {
    const store = await buildStore();
    // Wall-A's Reference is an instance-only override in this fixture from
    // Wall-B's perspective too — but to isolate "instance property, no type
    // involvement at all" re-use IsExternal is type-only, so assert the
    // pre-existing instance-property path (Reference on Wall-A) still
    // resolves via the ordinary instance pset row, independent of type
    // merging (a type with NO Pset_WallCommon.Reference key would still let
    // this match — precedence test above already isolates the override).
    const out = evaluateFilterRules('m1', store, [
      Rule.property('Pset_WallCommon', 'Reference', 'eq', 'INSTANCE-REF'),
    ], 'AND');
    assert.deepStrictEqual(out.map((r) => r.expressId), [100]);
  });

  it('BOUNDING CONTROL (ii): an entity with NEITHER instance nor type pset does not match', async () => {
    const store = await buildStore();
    const out = evaluateFilterRules('m1', store, [
      Rule.property('Pset_WallCommon', 'IsExternal', 'eq', 'true'),
    ], 'AND');
    assert.ok(!out.some((r) => r.expressId === 120), 'Door-C has no Pset_WallCommon anywhere and must not match');

    const outAny = evaluateFilterRules('m1', store, [
      Rule.property('Pset_WallCommon', 'Reference', 'isSet', ''),
    ], 'AND');
    assert.ok(!outAny.some((r) => r.expressId === 120), 'Door-C must not match isSet either — it has no Pset_WallCommon at all');
  });

  it('BOUNDING CONTROL (iii) — DELIBERATE BEHAVIOUR CHANGE: isSet now counts a type-only property as "set"', async () => {
    const store = await buildStore();
    // Wall-B has NO own psets — IsExternal is set ONLY via the type. Before
    // this fix isSet only consulted instance psets, so this would have been
    // false for Wall-B. That is the deliberate, called-out behaviour change:
    // presence semantics now match what the Properties panel already shows
    // the user (the type-inherited section).
    const isSetOut = evaluateFilterRules('m1', store, [
      Rule.property('Pset_WallCommon', 'IsExternal', 'isSet', ''),
    ], 'AND');
    assert.deepStrictEqual(isSetOut.map((r) => r.expressId).sort((a, b) => a - b), [100, 110]);

    // Scoped to Wall/Door so the assertion isn't diluted by the fixture's
    // other entities (IfcProject, IfcWallType, IfcRelDefinesByType), none of
    // which carry a Pset_WallCommon either and would otherwise also match.
    const isNotSetOut = evaluateFilterRules('m1', store, [
      Rule.ifcType(['IfcWall', 'IfcDoor']),
      Rule.property('Pset_WallCommon', 'IsExternal', 'isNotSet', ''),
    ], 'AND');
    // Door-C (no psets anywhere) is the only one for which IsExternal is
    // genuinely not set.
    assert.deepStrictEqual(isNotSetOut.map((r) => r.expressId), [120]);
  });
});
