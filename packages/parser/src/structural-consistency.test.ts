/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Physical vs structural analysis model consistency (#9668). Fixture
 * expectations are the ids an independent ifcopenshell pass reports for the
 * same rules, not values derived from the module under test.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from './index.js';
import { extractStructuralOnDemand } from './structural-extractor.js';
import { checkStructuralConsistency, DEFAULT_AXIS_DRIFT_TOLERANCE, type PhysicalElementFact, type StructuralConsistencyIssue, type StructuralLine } from './structural-consistency.js';
import { structuralConsistencyFacts, structuralConsistencyIssues } from './structural-consistency-facts.js';
import type { StructuralConnectionInfo, StructuralExtraction, StructuralMemberInfo } from './structural-types.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function parse(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new IfcParser().parseColumnar(buffer);
}

const member = (expressId: number, type: string, physicalElementIds: number[] = []): StructuralMemberInfo => ({
  expressId, globalId: `M${expressId}`, type, physicalElementIds,
  connectionGlobalIds: [], activityGlobalIds: [], analysisModelGlobalIds: [],
});
const connection = (expressId: number, physicalElementIds: number[] = []): StructuralConnectionInfo => ({
  expressId, globalId: `C${expressId}`, type: 'IfcStructuralPointConnection', physicalElementIds,
  memberGlobalIds: [], activityGlobalIds: [], analysisModelGlobalIds: [],
});
const model = (members: StructuralMemberInfo[], connections: StructuralConnectionInfo[] = [], hasAnalysisModel = true): StructuralExtraction => ({
  analysisModels: hasAnalysisModel ? [{ expressId: 900, globalId: 'A', loadGroupGlobalIds: [], resultGroupGlobalIds: [], itemGlobalIds: [] }] : [],
  members, connections, activities: [], loadGroups: [], resultGroups: [], hasStructural: true, loadsTruncated: false,
});
const fact = (expressId: number, type: string, loadBearing?: boolean): PhysicalElementFact =>
  ({ expressId, globalId: `P${expressId}`, type, ...(loadBearing === undefined ? {} : { loadBearing }) });
const ids = (issues: StructuralConsistencyIssue[], rule: string) =>
  issues.filter((issue) => issue.rule === rule).map((issue) => issue.target === undefined ? issue.entityId : [issue.entityId, issue.target]);

describe('structural-unlinked-element', () => {
  const elements = [fact(1, 'IfcBeam', true), fact(2, 'IfcColumn', false), fact(3, 'IfcWallStandardCase'), fact(4, 'IfcDoor', true), fact(5, 'IfcFooting', true)];

  it('reports load-bearing elements with no structural item, and names the element', () => {
    const issues = checkStructuralConsistency(model([member(10, 'IfcStructuralCurveMember', [5])]), elements);
    expect(ids(issues, 'structural-unlinked-element')).toEqual([1, 3]);
    const beam = issues.find((issue) => issue.entityId === 1)!;
    expect(beam).toMatchObject({ severity: 'warning', globalId: 'P1' });
    expect(beam.message).toContain('LoadBearing is true');
    expect(issues.find((issue) => issue.entityId === 3)!.message).toContain('LoadBearing is not stated as true or false');
  });

  it('includes piles', () => {
    const issues = checkStructuralConsistency(model([member(10, 'IfcStructuralCurveMember')]), [fact(1, 'IfcPile', true), fact(2, 'IfcPile', false)]);
    expect(ids(issues, 'structural-unlinked-element')).toEqual([1]);
  });

  it('leaves the GlobalId out of the message when the entity has none', () => {
    const issues = checkStructuralConsistency(model([member(10, 'IfcStructuralCurveMember')]), [{ expressId: 7, globalId: '', type: 'IfcBeam' }]);
    expect(issues[0].message).toMatch(/^#7 IfcBeam is load bearing/);
  });

  it('treats an unset LoadBearing as not load bearing when asked to', () => {
    const issues = checkStructuralConsistency(model([member(10, 'IfcStructuralCurveMember', [5])]), elements, { unsetLoadBearing: false });
    expect(ids(issues, 'structural-unlinked-element')).toEqual([1]);
  });

  it('does not run in a file with no analytical model', () => {
    expect(checkStructuralConsistency(model([], [], false), elements)).toEqual([]);
  });

  it('runs on structural members alone, without an IfcStructuralAnalysisModel', () => {
    expect(ids(checkStructuralConsistency(model([member(10, 'IfcStructuralCurveMember')], [], false), elements), 'structural-unlinked-element')).toEqual([1, 3, 5]);
  });

  it('counts a link from a connection as a counterpart', () => {
    const issues = checkStructuralConsistency(model([member(10, 'IfcStructuralCurveMember', [5])], [connection(20, [1, 3])]), elements);
    expect(ids(issues, 'structural-unlinked-element')).toEqual([]);
  });
});

describe('structural-unlinked-item', () => {
  it('reports unlinked members once the file links any member', () => {
    const issues = checkStructuralConsistency(model([member(10, 'IfcStructuralCurveMember', [1]), member(11, 'IfcStructuralSurfaceMember')]), [fact(1, 'IfcBeam')]);
    expect(ids(issues, 'structural-unlinked-item')).toEqual([11]);
    expect(issues.find((issue) => issue.entityId === 11)).toMatchObject({ globalId: 'M11', severity: 'warning' });
  });

  it('checks connections only when the file links a connection', () => {
    const elements = [fact(1, 'IfcBeam'), fact(2, 'IfcFooting')];
    const unlinkedConnections = model([member(10, 'IfcStructuralCurveMember', [1])], [connection(20), connection(21)]);
    expect(ids(checkStructuralConsistency(unlinkedConnections, elements), 'structural-unlinked-item')).toEqual([]);
    const oneLinked = model([member(10, 'IfcStructuralCurveMember', [1])], [connection(20, [2]), connection(21)]);
    expect(ids(checkStructuralConsistency(oneLinked, elements), 'structural-unlinked-item')).toEqual([21]);
  });

  it('reports nothing for a purely analytical file', () => {
    expect(checkStructuralConsistency(model([member(10, 'IfcStructuralCurveMember')], [connection(20)]), [])).toEqual([]);
  });
});

describe('structural-class-mismatch', () => {
  const elements = [fact(1, 'IfcSlab'), fact(2, 'IfcBeam'), fact(3, 'IfcColumn'), fact(4, 'IfcWallStandardCase'), fact(5, 'IfcFooting'), fact(6, 'IfcPlate')];

  it('names both entities for a curve member on a slab and a surface member on a column', () => {
    const issues = checkStructuralConsistency(model([
      member(10, 'IfcStructuralCurveMember', [1, 2]),
      member(11, 'IfcStructuralSurfaceMember', [3, 4]),
    ]), elements);
    expect(ids(issues, 'structural-class-mismatch')).toEqual([[10, 1], [11, 3]]);
    expect(issues.find((issue) => issue.entityId === 10)).toMatchObject({ globalId: 'M10', target: 1, targetGlobalId: 'P1' });
  });

  it('includes the IFC2X3 varying members and the physical subtypes', () => {
    const issues = checkStructuralConsistency(model([
      member(10, 'IfcStructuralCurveMemberVarying', [4, 6]),
      member(11, 'IfcStructuralSurfaceMemberVarying', [2]),
    ]), elements);
    expect(ids(issues, 'structural-class-mismatch')).toEqual([[10, 4], [11, 2]]);
  });

  it('accepts a curve member on a beam, footing or plate and a surface member on a slab or wall', () => {
    const issues = checkStructuralConsistency(model([
      member(10, 'IfcStructuralCurveMember', [2, 5, 6]),
      member(11, 'IfcStructuralSurfaceMember', [1, 4]),
    ]), elements);
    expect(ids(issues, 'structural-class-mismatch')).toEqual([]);
  });
});

describe('structural-unconnected-member', () => {
  const connected = (expressId: number, type = 'IfcStructuralCurveMember') =>
    ({ ...member(expressId, type), connectionGlobalIds: ['C1'], IfcRelConnectsStructuralMember: [{ expressId: 100 + expressId, RelatedStructuralConnection: 20 }] });

  it('reports every member with no connection once any member is connected', () => {
    const issues = checkStructuralConsistency(model([connected(10), member(11, 'IfcStructuralCurveMember'), member(12, 'IfcStructuralSurfaceMember')]), []);
    expect(ids(issues, 'structural-unconnected-member')).toEqual([11, 12]);
    expect(issues.find((issue) => issue.entityId === 11)).toMatchObject({ severity: 'warning', globalId: 'M11' });
  });

  it('counts a relationship whose connection has no GlobalId as a connection', () => {
    const related = { ...member(11, 'IfcStructuralCurveMember'), IfcRelConnectsStructuralMember: [{ expressId: 50, RelatedStructuralConnection: 20 }] };
    expect(ids(checkStructuralConsistency(model([connected(10), related]), []), 'structural-unconnected-member')).toEqual([]);
  });

  it('does not run in a file that connects no member', () => {
    expect(ids(checkStructuralConsistency(model([member(10, 'IfcStructuralCurveMember'), member(11, 'IfcStructuralSurfaceMember')]), []), 'structural-unconnected-member')).toEqual([]);
  });
});

describe('structural-axis-drift', () => {
  const elements = [fact(1, 'IfcBeam', true)];
  const along: StructuralLine = [[0, 0, 3], [6, 0, 3]];
  const lines = (line: StructuralLine, axis: StructuralLine | null = along) =>
    ({ memberLines: new Map([[10, line]]), physicalAxes: new Map(axis ? [[1, axis]] : []) });
  const linked = model([member(10, 'IfcStructuralCurveMember', [1])]);
  const drift = (issues: StructuralConsistencyIssue[]) => issues.filter((issue) => issue.rule === 'structural-axis-drift');

  it('reports a member off its element\'s axis with the distance of its farther end', () => {
    const issues = drift(checkStructuralConsistency(linked, elements, {}, lines([[0, 0.1, 3], [6, 0.3, 3.4]])));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ entityId: 10, globalId: 'M10', target: 1, targetGlobalId: 'P1' });
    expect(issues[0].distance).toBeCloseTo(0.5, 9);
    expect(issues[0].message).toContain('0.500 m');
  });

  it('ignores ends moved along the axis, as the derivation does at joints', () => {
    expect(drift(checkStructuralConsistency(linked, elements, {}, lines([[-0.2, 0, 3], [5.5, 0, 3]])))).toEqual([]);
  });

  it('reports only past the tolerance, default 0.05 m', () => {
    expect(DEFAULT_AXIS_DRIFT_TOLERANCE).toBe(0.05);
    const within = lines([[0, 0.049, 3], [6, 0, 3]]);
    expect(drift(checkStructuralConsistency(linked, elements, {}, within))).toEqual([]);
    expect(drift(checkStructuralConsistency(linked, elements, {}, lines([[0, 0.051, 3], [6, 0, 3]])))).toHaveLength(1);
    expect(drift(checkStructuralConsistency(linked, elements, { axisDriftTolerance: 0.01 }, within))).toHaveLength(1);
    expect(() => checkStructuralConsistency(linked, elements, { axisDriftTolerance: Number.NaN }, within)).toThrow(/axisDriftTolerance/);
  });

  it('lets no wild coordinate widen the drift allowance past 1 micrometre', () => {
    // A garbage z of 1e14 m would allow 0.36 m uncapped; 0.1 mm of drift must still be reported.
    const wild = lines([[0, 0.0501, 1e14], [6, 0, 1e14]], [[0, 0, 1e14], [6, 0, 1e14]]);
    expect(drift(checkStructuralConsistency(linked, elements, {}, wild))).toHaveLength(1);
  });

  describe('does not report an end exactly at the tolerance', () => {
    const oblique = [0.6, 0.8, 0] as const;
    const WEB_MERCATOR_ANGLE = 0.33590935980955805;
    const cases = [
      ['along X at the origin', [0, 0, 0], [1, 0, 0]],
      ['at 45 degrees', [0, 0, 0], [Math.SQRT1_2, Math.SQRT1_2, 0]],
      ['at LV95 coordinates', [2600000, 1200000, 400], oblique],
      // From a 20000-end random search: a fixed 1 nm allowance misreports it (2.6e-9 m of rounding).
      ['at Web Mercator coordinates', [19492896, 17103716, 400], [Math.cos(WEB_MERCATOR_ANGLE), Math.sin(WEB_MERCATOR_ANGLE), 0]],
    ] as const;
    for (const [name, origin, axis] of cases) {
      it(name, () => {
        // `at(k, off)`: k metres along the axis from `origin`, then `off` metres square to it in plan.
        const at = (k: number, off: number) => [origin[0] + k * axis[0] - off * axis[1], origin[1] + k * axis[1] + off * axis[0], origin[2]] as const;
        const endAtTolerance = lines([at(0, 0), at(5, 0.05)], [at(0, 0), at(5, 0)]);
        expect(drift(checkStructuralConsistency(linked, elements, {}, endAtTolerance))).toEqual([]);
        expect(drift(checkStructuralConsistency(linked, elements, { axisDriftTolerance: 0.0499 }, endAtTolerance))).toHaveLength(1);
      });
    }

    // Members up to 41 axis lengths long: some ends fall under the 1 micrometre cap.
    it('over a seeded sweep of 2000 oblique ends at map-scale origins', () => {
      let seed = 1;
      const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      let reportedAtTolerance = 0;
      let missedPastTolerance = 0;
      for (let i = 0; i < 2000; i++) {
        const origin = [Math.round(1e6 + random() * 1.9e7), Math.round(1e6 + random() * 1.9e7), 400];
        const angle = random() * 2 * Math.PI;
        const at = (k: number, off: number) =>
          [origin[0] + k * Math.cos(angle) - off * Math.sin(angle), origin[1] + k * Math.sin(angle) + off * Math.cos(angle), 400] as const;
        const length = 5 + 200 * random();
        if (drift(checkStructuralConsistency(linked, elements, {}, lines([at(0, 0), at(length, 0.05)], [at(0, 0), at(5, 0)]))).length) reportedAtTolerance++;
        // 10 micrometres past the tolerance is drift: the allowance never hides it.
        if (!drift(checkStructuralConsistency(linked, elements, {}, lines([at(0, 0), at(length, 0.05001)], [at(0, 0), at(5, 0)]))).length) missedPastTolerance++;
      }
      expect({ reportedAtTolerance, missedPastTolerance }).toEqual({ reportedAtTolerance: 0, missedPastTolerance: 0 });
    });
  });

  it('needs both lines, a link and the element', () => {
    const off: StructuralLine = [[0, 1, 3], [6, 1, 3]];
    expect(drift(checkStructuralConsistency(linked, elements, {}, lines(off, null)))).toEqual([]);
    expect(drift(checkStructuralConsistency(linked, elements))).toEqual([]);
    expect(drift(checkStructuralConsistency(model([member(10, 'IfcStructuralCurveMember')]), elements, {}, lines(off)))).toEqual([]);
    expect(drift(checkStructuralConsistency(linked, [], {}, lines(off)))).toEqual([]);
    expect(drift(checkStructuralConsistency(linked, elements, {}, lines(off, [[1, 1, 1], [1, 1, 1]])))).toEqual([]);
    expect(drift(checkStructuralConsistency(linked, elements, {}, lines([[0, Number.NaN, 3], [6, 1, 3]])))).toEqual([]);
  });
});

const IFC4X3 = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4X3_ADD2'));ENDSEC;DATA;
#9=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
#1=IFCBEAM('2Beam000000000000000001',$,'Beam',$,$,$,$,$,$);
#2=IFCCOLUMN('2Colu000000000000000001',$,'Column',$,$,$,$,$,$);
#3=IFCWALL('2Wall000000000000000001',$,'Wall',$,$,$,$,$,$);
#4=IFCSLAB('2Slab000000000000000001',$,'Slab',$,$,$,$,$,$);
#5=IFCMEMBER('2Memb000000000000000001',$,'Brace',$,$,$,$,$,$);
#6=IFCFOOTING('2Foot000000000000000001',$,'Footing',$,$,$,$,$,$);
#8=IFCPILE('2Pile000000000000000001',$,'Pile',$,$,$,$,$,.BORED.,$);
#40=IFCPROPERTYSET('2Pset000000000000000008',$,'Pset_PileCommon',$,(#20));
#41=IFCRELDEFINESBYPROPERTIES('2Rel0000000000000000009',$,$,$,(#8),#40);
#10=IFCSTRUCTURALCURVEMEMBER('2Curv000000000000000001',$,'On wall',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#11=IFCSTRUCTURALCURVEMEMBER('2Curv000000000000000002',$,'Unlinked',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#12=IFCSTRUCTURALPOINTCONNECTION('2Node000000000000000001',$,'Node',$,$,$,$,$,$);
#13=IFCRELASSIGNSTOPRODUCT('2Rel0000000000000000001',$,$,$,(#10),$,#3);
#20=IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$);
#21=IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.F.),$);
#22=IFCPROPERTYSET('2Pset000000000000000001',$,'Pset_BeamCommon',$,(#20));
#23=IFCRELDEFINESBYPROPERTIES('2Rel0000000000000000002',$,$,$,(#1),#22);
#24=IFCPROPERTYSET('2Pset000000000000000002',$,'PSet_ColumnCommon',$,(#21));
#25=IFCRELDEFINESBYPROPERTIES('2Rel0000000000000000003',$,$,$,(#2),#24);
#26=IFCPROPERTYSET('2Pset000000000000000003',$,'Pset_MemberCommon',$,(#20));
#27=IFCMEMBERTYPE('2Type000000000000000001',$,'Brace type',$,$,(#26),$,$,$,.BRACE.);
#28=IFCRELDEFINESBYTYPE('2Rel0000000000000000004',$,$,$,(#5),#27);
#29=IFCPROPERTYSET('2Pset000000000000000004',$,'Pset_FootingCommon',$,(#21));
#30=IFCFOOTINGTYPE('2Type000000000000000002',$,'Footing type',$,$,(#29),$,$,$,.PAD_FOOTING.);
#31=IFCRELDEFINESBYTYPE('2Rel0000000000000000005',$,$,$,(#6),#30);
#32=IFCPROPERTYSET('2Pset000000000000000005',$,'Pset_FootingCommon',$,(#20));
#33=IFCRELDEFINESBYPROPERTIES('2Rel0000000000000000006',$,$,$,(#6),#32);
#34=IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCLOGICAL(.U.),$);
#35=IFCPROPERTYSET('2Pset000000000000000006',$,'PSet_SlabCommon',$,(#34));
#36=IFCRELDEFINESBYPROPERTIES('2Rel0000000000000000007',$,$,$,(#4),#35);
#37=IFCPROPERTYSET('2Pset000000000000000007',$,'Pset_SlabCommon',$,(#21));
#38=IFCSLABTYPE('2Type000000000000000003',$,'Slab type',$,$,(#37),$,$,$,.FLOOR.);
#39=IFCRELDEFINESBYTYPE('2Rel0000000000000000008',$,$,$,(#4),#38);
ENDSEC;END-ISO-10303-21;`;

describe('structuralConsistencyFacts on an IFC4X3 file', () => {
  it('reads LoadBearing from the occurrence over its type, in any pset-name case, with UNKNOWN as unstated, and runs all three rules', async () => {
    const store = await parse(new TextEncoder().encode(IFC4X3));
    expect(store.schemaVersion).toBe('IFC4X3');
    const structural = extractStructuralOnDemand(store);
    const facts = structuralConsistencyFacts(store, structural);
    expect(facts.map((f) => [f.expressId, f.type, f.loadBearing])).toEqual([
      [1, 'IfcBeam', true], [2, 'IfcColumn', false], [3, 'IfcWall', undefined],
      [4, 'IfcSlab', undefined], [5, 'IfcMember', true], [6, 'IfcFooting', true], [8, 'IfcPile', true],
    ]);
    expect(facts[0].globalId).toBe('2Beam000000000000000001');

    const issues = checkStructuralConsistency(structural, facts);
    expect(ids(issues, 'structural-unlinked-element')).toEqual([1, 4, 5, 6, 8]);
    expect(ids(issues, 'structural-unlinked-item')).toEqual([11]);
    expect(ids(issues, 'structural-class-mismatch')).toEqual([[10, 3]]);
    expect(issues.find((issue) => issue.rule === 'structural-class-mismatch' && issue.entityId === 10))
      .toMatchObject({ globalId: '2Curv000000000000000001', targetGlobalId: '2Wall000000000000000001' });
  });
});

// Ids from the ifcopenshell pass over the same files (IfcRelAssignsToProduct
// both ways, plus IfcRelConnectsStructuralElement in IFC2X3).
const FIXTURES = [
  { path: 'ara3d/ISSUE_171_IfcSurfaceCurveSweptAreaSolid.ifc', schema: 'IFC4', element: [49, 1500, 2222, 2837, 3327, 3441], item: [] },
  { path: 'ifcopenshell/generated_structural_coverage_ifc2x3.ifc', schema: 'IFC2X3', element: [], item: [32, 34, 40] },
  { path: 'structural/ifc_structuralanalysisview/roof_truss--Axis-Struc.ifc', schema: 'IFC2X3', element: [], item: [] },
  { path: 'structural/ifc_structuralanalysisview/house_basement_floor--Axis-Struc.ifc', schema: 'IFC2X3', element: [], item: [] },
  { path: 'buildingsmart/Building-Structural.ifc', schema: 'IFC4', element: [], item: [] },
];

describe('structural consistency on real files', () => {
  it('lists the fixtures in the committed manifest so CI fetches them', () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'tests/models/manifest.json'), 'utf8')) as { files?: { path?: string }[] };
    const paths = (manifest.files ?? []).map((file) => file.path);
    for (const fixture of FIXTURES) expect(paths).toContain(fixture.path);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.schema}: ${fixture.path.split('/').pop()}`, async (ctx) => {
      const file = resolve(REPO_ROOT, 'tests/models', fixture.path);
      if (!existsSync(file)) ctx.skip(`${fixture.path} missing — run \`pnpm fixtures\` to fetch it`);
      const store = await parse(readFileSync(file));
      expect(store.schemaVersion).toBe(fixture.schema);
      const issues = structuralConsistencyIssues(store);
      expect(ids(issues, 'structural-unlinked-element')).toEqual(fixture.element);
      expect(ids(issues, 'structural-unlinked-item')).toEqual(fixture.item);
      expect(ids(issues, 'structural-class-mismatch')).toEqual([]);
    });
  }
});
