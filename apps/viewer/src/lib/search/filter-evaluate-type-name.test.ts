/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `type=WT01` (IfcOpenShell selector syntax, #4094) matches an element
 * whose RELATING TYPE (via `IfcRelDefinesByType`) has that Name — not the
 * element's own `IfcType.getTypeName()` (its IFC *class*, e.g. "IfcWall"),
 * which is a completely different dimension already covered by the
 * `ifcType` rule. Before this fix, `selector-to-rules.ts` reported every
 * `type=` term as unsupported (see #4094's adapter comment
 * `"matching an element's type by name is not supported yet (#4094)"`),
 * so the Filter tab's Selector field silently dropped the term rather than
 * narrowing by it.
 *
 * Reuses the exact fixture shape from `filter-evaluate-type-psets.test.ts`:
 * Wall-A/Wall-B (#100/#110) are both typed to `IfcWallType` "WT-Std" (#200)
 * via `IfcRelDefinesByType` #230; Door-C (#120) has no type relation at all.
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
#210=IFCPROPERTYSET('Pset00000000000000001A',$,'Pset_WallCommon',$,(#211));
#211=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#230=IFCRELDEFINESBYTYPE('Rdbt00000000000000001A',$,$,$,(#100,#110),#200);
ENDSEC;
END-ISO-10303-21;
`;

async function buildStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(FIXTURE);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true }) as unknown as Promise<IfcDataStore>;
}

describe('evaluateFilterRules — type= (relating type Name)', () => {
  it('matches every element whose IfcRelDefinesByType-related type has the given Name', async () => {
    const store = await buildStore();
    const out = evaluateFilterRules('m1', store, [
      Rule.typeName('eq', 'WT-Std'),
    ], 'AND');
    assert.deepStrictEqual(out.map((r) => r.expressId).sort((a, b) => a - b), [100, 110]);
  });

  it('an element with no IfcRelDefinesByType relation never matches', async () => {
    const store = await buildStore();
    const out = evaluateFilterRules('m1', store, [
      Rule.typeName('eq', 'WT-Std'),
    ], 'AND');
    assert.ok(!out.some((r) => r.expressId === 120), 'Door-C has no type relation and must not match');
  });

  it('is a distinct dimension from ifcType (the element\'s own IFC class)', async () => {
    const store = await buildStore();
    // "IfcWall" is Wall-A/Wall-B's own class, not their type's Name — a
    // type= rule must not fall back to matching the class name.
    const out = evaluateFilterRules('m1', store, [
      Rule.typeName('eq', 'IfcWall'),
    ], 'AND');
    assert.deepStrictEqual(out, []);
  });
});
