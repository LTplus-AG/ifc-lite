/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `parent=Foo` (IfcOpenShell selector syntax, #4903) — the element is a
 * direct OR INDIRECT child, in the spatial hierarchy, of an element whose
 * `Name` is `Foo`. The walk goes upward through BOTH containment
 * (`IfcRelContainedInSpatialStructure`) and aggregation (`IfcRelAggregates`)
 * to any depth. Before this fix, `selector-to-rules.ts` reported every
 * `parent=` term as `"parent=" is not supported` — see
 * `selector-to-rules.test.ts`'s superseded `parent= and query:` test.
 *
 * Fixture (see `SPATIAL_IFC` layout below):
 *
 *   Site(#41) --agg--> Building-Alpha(#42) --agg--> Level-3(#43), Level-4(#45)
 *   Level-3(#43) --contains--> Wall-Direct(#51), Assembly-01(#55)
 *   Assembly-01(#55) --aggregates--> Beam-Part(#56)     [BOTH edge kinds, 2 hops]
 *   Level-4(#45) --contains--> Wall-Level4(#52)
 *
 * plus a disconnected, malformed `IfcRelAggregates` cycle (Cycle-A #57 <->
 * Cycle-B #58, with Cycle-Elem #59 aggregated under #57) to prove the walk
 * terminates instead of hanging on a cyclic file.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules } from './filter-evaluate.js';
import { Rule } from './filter-rules.js';

const SPATIAL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCSITE('0Site00000000000000001',$,'Site',$,$,#40,$,$,.ELEMENT.,$,$,$,$,$);
#42= IFCBUILDING('0Bldg00000000000000001',$,'Building-Alpha',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCBUILDINGSTOREY('0Storey00000000000001',$,'Level 3',$,$,#40,$,$,.ELEMENT.,9.);
#45= IFCBUILDINGSTOREY('0Storey00000000000002',$,'Level 4',$,$,#40,$,$,.ELEMENT.,12.);
#51= IFCWALL('0Wall0000000000000001A',$,'Wall-Direct',$,$,#40,$,'tag',$);
#52= IFCWALL('0Wall0000000000000002A',$,'Wall-Level4',$,$,#40,$,'tag',$);
#55= IFCWALL('0Wall0000000000000005A',$,'Assembly-01',$,$,#40,$,'tag',$);
#56= IFCWALL('0Wall0000000000000006A',$,'Beam-Part',$,$,#40,$,'tag',$);
#57= IFCWALL('0Wall0000000000000007A',$,'Cycle-A',$,$,#40,$,'tag',$);
#58= IFCWALL('0Wall0000000000000008A',$,'Cycle-B',$,$,#40,$,'tag',$);
#59= IFCWALL('0Wall0000000000000009A',$,'Cycle-Elem',$,$,#40,$,'tag',$);
#60= IFCRELAGGREGATES('0Agg00000000000000001',$,$,$,#1,(#41));
#61= IFCRELAGGREGATES('0Agg00000000000000002',$,$,$,#41,(#42));
#62= IFCRELAGGREGATES('0Agg00000000000000003',$,$,$,#42,(#43,#45));
#70= IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont0000000000000001',$,$,$,(#51),#43);
#71= IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont0000000000000002',$,$,$,(#52),#45);
#72= IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont0000000000000003',$,$,$,(#55),#43);
#73= IFCRELAGGREGATES('0Agg00000000000000005',$,$,$,#55,(#56));
#80= IFCRELAGGREGATES('0Agg00000000000000006',$,$,$,#57,(#59));
#81= IFCRELAGGREGATES('0Agg00000000000000007',$,$,$,#58,(#57));
#82= IFCRELAGGREGATES('0Agg00000000000000008',$,$,$,#57,(#58));
ENDSEC;
END-ISO-10303-21;
`;

const WALL_DIRECT = 51;   // containment 1 hop: Wall -> Level 3
const WALL_LEVEL4 = 52;   // containment 1 hop: Wall -> Level 4 (must NOT match "Level 3")
const ASSEMBLY = 55;      // containment 1 hop: Assembly -> Level 3
const BEAM_PART = 56;     // aggregation THEN containment: Beam -> Assembly -> Level 3 (2 hops, both edge kinds)
const CYCLE_ELEM = 59;    // aggregation into a malformed mutual-aggregation cycle (#57 <-> #58)
const PROJECT = 1;        // root — has no ancestors at all

async function parseSpatialStore(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(SPATIAL_IFC);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

describe('evaluateFilterRules — parent= (spatial ancestor, #4903)', () => {
  it('matches the element directly contained in the named storey', async () => {
    const store = await parseSpatialStore();
    const out = evaluateFilterRules('m1', store, [Rule.parent('eq', 'Level 3')], 'AND');
    const ids = out.map((e) => e.expressId).sort((a, b) => a - b);
    assert.ok(ids.includes(WALL_DIRECT), `expected ${WALL_DIRECT} (Wall-Direct) to match, got ${ids}`);
    assert.ok(ids.includes(ASSEMBLY), `expected ${ASSEMBLY} (Assembly-01) to match, got ${ids}`);
  });

  it('reaches a grandparent through BOTH edge kinds in the same walk (aggregation then containment)', async () => {
    const store = await parseSpatialStore();
    // Beam-Part -> (aggregates) Assembly-01 -> (contains) Level 3.
    const out = evaluateFilterRules('m1', store, [Rule.parent('eq', 'Level 3')], 'AND');
    const ids = out.map((e) => e.expressId);
    assert.ok(ids.includes(BEAM_PART), `Beam-Part must match via aggregation+containment, got ${ids}`);
  });

  it('reaches ANY depth: a great-grandparent (Building-Alpha) matches through storey AND site aggregation', async () => {
    const store = await parseSpatialStore();
    // Wall-Direct -> (contains) Level 3 -> (aggregates) Building-Alpha: 2 hops.
    // Beam-Part -> (aggregates) Assembly-01 -> (contains) Level 3 -> (aggregates) Building-Alpha: 3 hops.
    // Level 3 and Level 4 themselves are also elements whose direct
    // aggregation parent IS Building-Alpha (1 hop) — they match too.
    const LEVEL_3 = 43;
    const LEVEL_4 = 45;
    const out = evaluateFilterRules('m1', store, [Rule.parent('eq', 'Building-Alpha')], 'AND');
    const ids = out.map((e) => e.expressId).sort((a, b) => a - b);
    assert.deepStrictEqual(
      ids,
      [LEVEL_3, LEVEL_4, WALL_DIRECT, WALL_LEVEL4, ASSEMBLY, BEAM_PART].sort((a, b) => a - b),
    );
  });

  it('a non-matching name is an EMPTY result, not everything (#4903 — the decisive inversion)', async () => {
    const store = await parseSpatialStore();
    const out = evaluateFilterRules('m1', store, [Rule.parent('eq', 'Nonexistent Storey Name')], 'AND');
    assert.deepStrictEqual(out, [], 'parent= on a name no ancestor has must match NOTHING, not everything');
  });

  it('an element with zero ancestors (the project root) matches neither a positive nor a negative op', async () => {
    const store = await parseSpatialStore();
    const positive = evaluateFilterRules('m1', store, [Rule.parent('eq', 'Level 3')], 'AND');
    const negative = evaluateFilterRules('m1', store, [Rule.parent('ne', 'Level 3')], 'AND');
    assert.ok(!positive.some((e) => e.expressId === PROJECT));
    assert.ok(!negative.some((e) => e.expressId === PROJECT));
  });

  it('a malformed aggregation cycle does not hang or overflow the stack', async () => {
    const store = await parseSpatialStore();
    const out = evaluateFilterRules('m1', store, [Rule.parent('eq', 'Level 3')], 'AND');
    // Cycle-Elem's only ancestors are Cycle-A/Cycle-B, neither named "Level 3".
    assert.ok(!out.some((e) => e.expressId === CYCLE_ELEM));
  });

  it('the negated op (!=) matches an element whose ancestors exist but none named "Level 3"', async () => {
    const store = await parseSpatialStore();
    const out = evaluateFilterRules('m1', store, [Rule.parent('ne', 'Level 3')], 'AND');
    const ids = out.map((e) => e.expressId);
    assert.ok(ids.includes(WALL_LEVEL4), 'Wall-Level4\'s ancestors are Level 4/Building-Alpha/Site/Proj — none "Level 3"');
  });

  it('is a distinct dimension from storey (location=): a grandparent match is not the same as the one-hop storey rule', async () => {
    const store = await parseSpatialStore();
    // storey (location=) matches only the DIRECT/one-hop-through-space set;
    // it never reaches Building-Alpha. parent= does.
    const storeyOut = evaluateFilterRules('m1', store, [Rule.storey(['Building-Alpha'])], 'AND');
    assert.deepStrictEqual(storeyOut, []);
    const parentOut = evaluateFilterRules('m1', store, [Rule.parent('eq', 'Building-Alpha')], 'AND');
    assert.ok(parentOut.length > 0);
  });
});
