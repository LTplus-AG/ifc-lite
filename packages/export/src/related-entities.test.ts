/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `collectRelatedEntities` (#2934, the "anonymized isolated export" feature):
 * expanding a seed selection by relationship kind — host/opening/filler
 * chain, aggregate parents/children split by `IfcRelAggregates` vs
 * `IfcRelNests`, type objects, materials (rel id only, per its own doc), the
 * spatial containment chain up to `IfcProject`, and a depth-bounded
 * `IfcRelConnectsPathElements` walk — plus the two "bounding walks over
 * file-supplied references" guarantees (AGENTS.md): a cycle terminates via
 * the global visited set, and a legitimately long acyclic chain reports
 * `truncated` via the work budget instead of walking the whole model.
 *
 * Real fixtures throughout (`new IfcParser().parseColumnar`), per this
 * repo's "assert behaviour through a real fixture" rule.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { collectRelatedEntities } from './related-entities.js';
import type { RelatedEntities, RelatedEntityGroup } from './anonymize-types.js';

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

async function parse(model: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(enc(model));
}

/** 22-char synthetic GlobalId, deterministic and unique per `n` — same shape
 *  `subset-mode.test.ts` uses. */
const guid = (n: number): string => `0GUID${String(n).padStart(17, '0')}`;

function group(result: RelatedEntities, relationship: string, role: string): RelatedEntityGroup | undefined {
  return result.groups.find((g) => g.relationship === relationship && g.role === role);
}

/**
 * Project(#1) -> Site(#2) -> Building(#3) -> Storey(#4), all via
 * `IfcRelAggregates`; Wall A(#5, host, contained in the storey) has an
 * `IfcOpeningElement`(#6, `IfcRelVoidsElement` #24) filled by a
 * `IfcWindow`(#7, `IfcRelFillsElement` #25); Wall A has an `IfcWallType`(#8,
 * `IfcRelDefinesByType` #26) and an `IfcMaterial`(#9,
 * `IfcRelAssociatesMaterial` #27); Wall B(#10) is structurally connected to
 * Wall A via `IfcRelConnectsPathElements`(#28) but otherwise unrelated
 * (no spatial containment, no shared type/material) — isolating the
 * connect-depth toggle from every other expansion.
 */
const FIXTURE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('related-entities-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#2=IFCSITE('${guid(2)}',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('${guid(3)}',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('${guid(4)}',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);
#11=IFCBUILDINGSTOREY('${guid(11)}',$,'Unrelated Storey',$,$,$,$,$,.ELEMENT.,3000.);
#5=IFCWALL('${guid(5)}',$,'Wall A',$,$,$,$,$);
#6=IFCOPENINGELEMENT('${guid(6)}',$,'Opening',$,$,$,$,$);
#7=IFCWINDOW('${guid(7)}',$,'Window',$,$,$,$,'w',1.,1.);
#8=IFCWALLTYPE('${guid(8)}',$,'WallType',$,$,$,$,$,$,.STANDARD.);
#9=IFCMATERIAL('Concrete');
#10=IFCWALL('${guid(10)}',$,'Wall B',$,$,$,$,$);
#20=IFCRELAGGREGATES('${guid(20)}',$,$,$,#1,(#2));
#21=IFCRELAGGREGATES('${guid(21)}',$,$,$,#2,(#3));
#22=IFCRELAGGREGATES('${guid(22)}',$,$,$,#3,(#4,#11));
#23=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(23)}',$,$,$,(#5),#4);
#24=IFCRELVOIDSELEMENT('${guid(24)}',$,$,$,#5,#6);
#25=IFCRELFILLSELEMENT('${guid(25)}',$,$,$,#6,#7);
#26=IFCRELDEFINESBYTYPE('${guid(26)}',$,$,$,(#5),#8);
#27=IFCRELASSOCIATESMATERIAL('${guid(27)}',$,$,$,(#5),#9);
#28=IFCRELCONNECTSPATHELEMENTS('${guid(28)}',$,$,$,$,#5,#10,(),(),.ATSTART.,.ATEND.);
ENDSEC;
END-ISO-10303-21;`;

describe('collectRelatedEntities — host/opening/filler and spatial containment chain', () => {
  it('a window seed reaches opening, host, storey, building, site and project by role, with default options', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = collectRelatedEntities(store, [7]);

    expect(result.truncated).toBe(false);
    expect(result.seeds).toEqual([7]);

    // Wall B, its connecting rel, and the material entity itself are NOT
    // reached: connect depth defaults to 0, and the material is deliberately
    // left to the export's own forward closure (see the group assertion
    // below).
    expect(result.all).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 20, 21, 22, 23, 24, 25, 26, 27]));

    expect(group(result, 'IfcRelFillsElement', 'opening')).toEqual({
      relationship: 'IfcRelFillsElement', role: 'opening', expressIds: [6], relationshipIds: [25],
    });
    expect(group(result, 'IfcRelVoidsElement', 'host')).toEqual({
      relationship: 'IfcRelVoidsElement', role: 'host', expressIds: [5], relationshipIds: [24],
    });
    expect(group(result, 'IfcRelContainedInSpatialStructure', 'container')).toEqual({
      relationship: 'IfcRelContainedInSpatialStructure', role: 'container', expressIds: [4], relationshipIds: [23],
    });
    expect(group(result, 'IfcRelDefinesByType', 'type')).toEqual({
      relationship: 'IfcRelDefinesByType', role: 'type', expressIds: [8], relationshipIds: [26],
    });
    // "AssociatesMaterial -> rel ids only" (plan A3): the material entity
    // (#9) is never added to `expressIds` or `all` — `IfcMaterial` is not an
    // `IfcRoot` descendant, so it is never excluded by `subset-roots.ts`
    // either; once the rel id is in the subset, the export's own forward
    // closure reaches the material through the rel's `RelatingMaterial` ref.
    expect(group(result, 'IfcRelAssociatesMaterial', 'material')).toEqual({
      relationship: 'IfcRelAssociatesMaterial', role: 'material', expressIds: [], relationshipIds: [27],
    });
    expect(result.all.has(9)).toBe(false);

    // The unconditional climb (storey -> building -> site -> project) is a
    // distinct role from the general `IfcRelAggregates` parent/child toggle,
    // and reaches every step of the chain, including the project.
    const ancestors = group(result, 'IfcRelAggregates', 'spatial ancestor');
    expect(ancestors?.expressIds).toEqual([1, 2, 3]);
    expect(ancestors?.relationshipIds).toEqual([20, 21, 22]);
  });

  it('sibling storeys are NOT pulled in through the building the climb reached (only relevant storeys are exported)', async () => {
    const store = await parse(FIXTURE_MODEL);
    // Default IfcRelAggregates: 'both' — the "down" half must not descend
    // from Building #3 (reached as a spatial ancestor) into Storey #11.
    const result = collectRelatedEntities(store, [7]);
    expect(result.all.has(11)).toBe(false);
    expect(result.all.has(4)).toBe(true);

    // Seeding the building itself DOES expand downward: that is the caller
    // asking for the building's decomposition.
    const fromBuilding = collectRelatedEntities(store, [3]);
    expect(fromBuilding.all.has(4)).toBe(true);
    expect(fromBuilding.all.has(11)).toBe(true);
  });

  it('IfcProject is always included, even with every toggle off', async () => {
    const store = await parse(FIXTURE_MODEL);
    const result = collectRelatedEntities(store, [7], {
      IfcRelVoidsElement: false,
      IfcRelFillsElement: false,
      IfcRelAggregates: 'none',
      IfcRelNests: 'none',
      IfcRelDefinesByType: false,
      IfcRelAssociatesMaterial: false,
      IfcRelContainedInSpatialStructure: false,
    });
    expect(result.all).toEqual(new Set([1, 7]));
  });
});

describe('collectRelatedEntities — toggles gate their own relationship, and nothing else', () => {
  it('unticking IfcRelDefinesByType removes the type object AND its rel; ticked, both are present', async () => {
    const store = await parse(FIXTURE_MODEL);

    const withType = collectRelatedEntities(store, [5]);
    expect(withType.all.has(8)).toBe(true);
    expect(withType.all.has(26)).toBe(true);

    const withoutType = collectRelatedEntities(store, [5], { IfcRelDefinesByType: false });
    expect(withoutType.all.has(8)).toBe(false);
    expect(withoutType.all.has(26)).toBe(false);
    // The rest of Wall A's context is unaffected by the one toggle.
    expect(withoutType.all.has(6)).toBe(true); // opening
    expect(withoutType.all.has(4)).toBe(true); // storey
  });

  it('IfcRelConnectsPathElementsDepth 0 (default) omits the connected wall; depth 1 includes it', async () => {
    const store = await parse(FIXTURE_MODEL);

    const depth0 = collectRelatedEntities(store, [5]);
    expect(depth0.all.has(10)).toBe(false);
    expect(depth0.all.has(28)).toBe(false);
    expect(group(depth0, 'IfcRelConnectsPathElements', 'connected')).toBeUndefined();

    const depth1 = collectRelatedEntities(store, [5], { IfcRelConnectsPathElementsDepth: 1 });
    expect(depth1.all.has(10)).toBe(true);
    expect(depth1.all.has(28)).toBe(true);
    expect(group(depth1, 'IfcRelConnectsPathElements', 'connected')).toEqual({
      relationship: 'IfcRelConnectsPathElements', role: 'connected', expressIds: [10], relationshipIds: [28],
    });
  });
});

describe('collectRelatedEntities — IfcRelAggregates and IfcRelNests split by relationship entity type', () => {
  const NEST_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('nests-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#2=IFCWALL('${guid(2)}',$,'Parent',$,$,$,$,$);
#3=IFCWALL('${guid(3)}',$,'Nested Child',$,$,$,$,$);
#4=IFCWALL('${guid(4)}',$,'Aggregated Child',$,$,$,$,$);
#30=IFCRELNESTS('${guid(30)}',$,$,$,#2,(#3));
#31=IFCRELAGGREGATES('${guid(31)}',$,$,$,#2,(#4));
ENDSEC;
END-ISO-10303-21;`;

  it('both relationship kinds are reached by default, in their own groups', async () => {
    const store = await parse(NEST_MODEL);
    const result = collectRelatedEntities(store, [2]);
    expect(result.all).toEqual(new Set([1, 2, 3, 4, 30, 31]));
    expect(group(result, 'IfcRelNests', 'child')).toEqual({
      relationship: 'IfcRelNests', role: 'child', expressIds: [3], relationshipIds: [30],
    });
    expect(group(result, 'IfcRelAggregates', 'child')).toEqual({
      relationship: 'IfcRelAggregates', role: 'child', expressIds: [4], relationshipIds: [31],
    });
  });

  it('IfcRelNests: "none" drops only the nested child, not the aggregated one', async () => {
    const store = await parse(NEST_MODEL);
    const result = collectRelatedEntities(store, [2], { IfcRelNests: 'none' });
    expect(result.all.has(3)).toBe(false);
    expect(result.all.has(30)).toBe(false);
    expect(result.all.has(4)).toBe(true);
    expect(result.all.has(31)).toBe(true);
  });
});

describe('collectRelatedEntities — bounding walks over file-supplied references', () => {
  it('a self-referential IfcRelAggregates terminates instead of looping forever', async () => {
    const model = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('self-ref-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);
#2=IFCWALL('${guid(2)}',$,'Self',$,$,$,$,$);
#30=IFCRELAGGREGATES('${guid(30)}',$,$,$,#2,(#2));
ENDSEC;
END-ISO-10303-21;`;
    const store = await parse(model);
    const result = collectRelatedEntities(store, [2], { IfcRelAggregates: 'both' });
    expect(result.truncated).toBe(false);
    expect(result.all).toEqual(new Set([1, 2, 30]));
  });

  it('a chain far longer than the work budget reports truncated instead of walking the whole model', async () => {
    // #2934 A6: 10k hops is large enough to guarantee it exceeds the work
    // budget no matter how generous, without hand-tuning the exact number.
    const CHAIN_LEN = 10_000;
    const NODE_BASE = 1000;
    const REL_BASE = 200_000;
    const lines: string[] = [
      'ISO-10303-21;', 'HEADER;',
      "FILE_DESCRIPTION((''),'2;1');",
      "FILE_NAME('chain-fixture.ifc','2024-01-01T00:00:00',(''),(''),'','','');",
      "FILE_SCHEMA(('IFC4'));",
      'ENDSEC;', 'DATA;',
      `#1=IFCPROJECT('${guid(1)}',$,'Project',$,$,$,$,$,$);`,
    ];
    for (let i = 0; i < CHAIN_LEN; i++) {
      lines.push(`#${NODE_BASE + i}=IFCWALL('${guid(NODE_BASE + i)}',$,'W${i}',$,$,$,$,$);`);
    }
    for (let i = 0; i < CHAIN_LEN - 1; i++) {
      lines.push(`#${REL_BASE + i}=IFCRELAGGREGATES('${guid(REL_BASE + i)}',$,$,$,#${NODE_BASE + i},(#${NODE_BASE + i + 1}));`);
    }
    lines.push('ENDSEC;', 'END-ISO-10303-21;');

    const store = await parse(lines.join('\n'));
    const result = collectRelatedEntities(store, [NODE_BASE]);
    expect(result.truncated).toBe(true);
    // The work budget is well under the chain length, so the far end of the
    // chain is never reached — a size comparison alone would not pin this
    // down (rel ids inflate `all` too), but "did it reach the last node"
    // does.
    expect(result.all.has(NODE_BASE + CHAIN_LEN - 1)).toBe(false);
  }, 30_000);
});
