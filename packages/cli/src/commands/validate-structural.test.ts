/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite validate` reports where the physical model and the structural
 * analysis model disagree (#9668). The rules are tested in `@ifc-lite/parser`;
 * this file pins that validate runs them and names the entity. Expected ids
 * come from an independent ifcopenshell pass.
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { computeValidationIssues, validateCommand } from './validate.js';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tests/models/ara3d/ISSUE_171_IfcSurfaceCurveSweptAreaSolid.ifc');

describe('validate: structural consistency', () => {
  it('lists the first 50 unlinked load-bearing elements, then one summary, then the other rules in full', async () => {
    const beams = Array.from({ length: 53 }, (_, i) => `#${100 + i}=IFCBEAM('2Beam${String(i).padStart(17, '0')}',$,'B',$,$,$,$,$,$);`);
    const members = Array.from({ length: 52 }, (_, i) => `#${300 + i}=IFCSTRUCTURALCURVEMEMBER('2Curv${String(i).padStart(17, '0')}',$,'M',$,$,$,$,.RIGID_JOINED_MEMBER.,$);`);
    const step = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
#2=IFCSTRUCTURALCURVEMEMBER('2CurvOnSlab00000000001',$,'On slab',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#3=IFCSLAB('2Slab000000000000000001',$,'S',$,$,$,$,$,$);
#4=IFCRELASSIGNSTOPRODUCT('2Rel0000000000000000001',$,$,$,(#2),$,#3);
${beams.join('\n')}
${members.join('\n')}
ENDSEC;END-ISO-10303-21;`;
    const issues = computeValidationIssues(await new IfcParser().parseColumnar(new TextEncoder().encode(step).buffer as ArrayBuffer))
      .filter((issue) => issue.rule.startsWith('structural-'));
    expect(issues.slice(0, 50).map((issue) => [issue.rule, issue.entityId]))
      .toEqual(Array.from({ length: 50 }, (_, i) => ['structural-unlinked-element', 100 + i]));
    expect(issues[50]).toEqual({
      severity: 'warning', rule: 'structural-unlinked-element',
      message: '3 more load-bearing element(s) with no structural item not listed (53 total)',
    });
    expect(issues.slice(51).map((issue) => [issue.rule, issue.entityId])).toEqual([
      ...Array.from({ length: 52 }, (_, i) => ['structural-unlinked-item', 300 + i]),
      ['structural-class-mismatch', 2],
      // The slab has no axis, so neither geometry rule compared its member.
      ['structural-unchecked-member', undefined],
      ['structural-unchecked-member', 2],
    ]);
  });

  it('lists the first 50 unconnected members, then one summary (#9931)', async () => {
    const members = Array.from({ length: 53 }, (_, i) => `#${300 + i}=IFCSTRUCTURALCURVEMEMBER('2Curv${String(i).padStart(17, '0')}',$,'M',$,$,$,$,.RIGID_JOINED_MEMBER.,$);`);
    const step = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
#2=IFCSTRUCTURALCURVEMEMBER('2Connected0000000000a',$,'Connected',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#3=IFCSTRUCTURALPOINTCONNECTION('2Conn000000000000000a',$,'C',$,$,$,$,$,$);
#4=IFCRELCONNECTSSTRUCTURALMEMBER('2Rel0000000000000000a',$,$,$,#2,#3,$,$,$,$);
${members.join('\n')}
ENDSEC;END-ISO-10303-21;`;
    const issues = computeValidationIssues(await new IfcParser().parseColumnar(new TextEncoder().encode(step).buffer as ArrayBuffer))
      .filter((issue) => issue.rule === 'structural-unconnected-member');
    expect(issues).toHaveLength(51);
    expect(issues.slice(0, 50).map((issue) => issue.entityId)).toEqual(Array.from({ length: 50 }, (_, i) => 300 + i));
    expect(issues[50]).toEqual({
      severity: 'warning', rule: 'structural-unconnected-member',
      message: '3 more structural member(s) with no connection not listed (53 total)',
    });
  });

  it('runs the axis-drift rule: a member 1 m off its beam is reported (#9931)', async () => {
    const step = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCAXIS2PLACEMENT3D(#10,$,$);
#12=IFCLOCALPLACEMENT($,#11);
#20=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.2,0.2);
#21=IFCDIRECTION((1.,0.,0.));
#22=IFCAXIS2PLACEMENT3D(#10,#21,$);
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCEXTRUDEDAREASOLID(#20,#22,#23,4.);
#25=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#24));
#26=IFCPRODUCTDEFINITIONSHAPE($,$,(#25));
#27=IFCBEAM('2Beam000000000000000a',$,'B',$,$,#12,#26,$,.BEAM.);
#30=IFCCARTESIANPOINT((0.,1.,0.));
#31=IFCCARTESIANPOINT((4.,1.,0.));
#32=IFCVERTEXPOINT(#30);
#33=IFCVERTEXPOINT(#31);
#34=IFCEDGE(#32,#33);
#35=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#34));
#36=IFCPRODUCTDEFINITIONSHAPE($,$,(#35));
#37=IFCSTRUCTURALCURVEMEMBER('2Curv000000000000000a',$,'M',$,$,#12,#36,.RIGID_JOINED_MEMBER.,$);
#38=IFCRELASSIGNSTOPRODUCT('2Rel0000000000000000a',$,$,$,(#37),$,#27);
ENDSEC;END-ISO-10303-21;`;
    const issues = computeValidationIssues(await new IfcParser().parseColumnar(new TextEncoder().encode(step).buffer as ArrayBuffer))
      .filter((issue) => issue.rule === 'structural-axis-drift');
    expect(issues.map((issue) => [issue.entityId, issue.target])).toEqual([[37, 27]]);
    expect((issues[0] as { distance?: number }).distance).toBeCloseTo(1, 6);
  });

  it('reports the curve members the movement and axis-drift rules did not compare, in text and JSON (#10640)', async () => {
    // #37 has no derivation record. #47 has an incomplete record and no readable edge.
    const step = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCAXIS2PLACEMENT3D(#10,$,$);
#12=IFCLOCALPLACEMENT($,#11);
#20=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.2,0.2);
#21=IFCDIRECTION((1.,0.,0.));
#22=IFCAXIS2PLACEMENT3D(#10,#21,$);
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCEXTRUDEDAREASOLID(#20,#22,#23,4.);
#25=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#24));
#26=IFCPRODUCTDEFINITIONSHAPE($,$,(#25));
#27=IFCBEAM('2Beam000000000000000a',$,'B',$,$,#12,#26,$,.BEAM.);
#30=IFCCARTESIANPOINT((0.,0.,0.));
#31=IFCCARTESIANPOINT((4.,0.,0.));
#32=IFCVERTEXPOINT(#30);
#33=IFCVERTEXPOINT(#31);
#34=IFCEDGE(#32,#33);
#35=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#34));
#36=IFCPRODUCTDEFINITIONSHAPE($,$,(#35));
#37=IFCSTRUCTURALCURVEMEMBER('2Curv000000000000000a',$,'M',$,$,#12,#36,.RIGID_JOINED_MEMBER.,$);
#38=IFCRELASSIGNSTOPRODUCT('2Rel0000000000000000a',$,$,$,(#37),$,#27);
#47=IFCSTRUCTURALCURVEMEMBER('2Curv000000000000000b',$,'N',$,$,#12,$,.RIGID_JOINED_MEMBER.,$);
#48=IFCRELASSIGNSTOPRODUCT('2Rel0000000000000000b',$,$,$,(#47),$,#27);
#49=IFCPROPERTYSINGLEVALUE('PhysicalElement',$,IFCLABEL('2Beam000000000000000a'),$);
#50=IFCPROPERTYSET('2Pset000000000000000a',$,'IfcLite_StructuralDerivation',$,(#49));
#51=IFCRELDEFINESBYPROPERTIES('2Rel0000000000000000c',$,$,$,(#47),#50);
ENDSEC;END-ISO-10303-21;`;
    const dir = mkdtempSync(join(tmpdir(), 'validate-coverage-'));
    const file = join(dir, 'partial.ifc');
    writeFileSync(file, step);
    const previousExitCode = process.exitCode;
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    try {
      await validateCommand([file]);
      const text = out.join('');
      out.length = 0;
      await validateCommand([file, '--json']);
      write.mockRestore();
      const unchecked = (JSON.parse(out.join('')) as { issues: Array<{ rule: string }> }).issues.filter((issue) => issue.rule === 'structural-unchecked-member');
      expect(unchecked).toEqual([
        { severity: 'info', rule: 'structural-unchecked-member', message: 'Movement or axis drift was not checked on 2 of 2 linked curve member(s)' },
        { severity: 'info', rule: 'structural-unchecked-member', entityId: 37, globalId: '2Curv000000000000000a',
          message: '#37 IfcStructuralCurveMember (2Curv000000000000000a): movement not checked: it has no derivation record' },
        { severity: 'warning', rule: 'structural-unchecked-member', entityId: 47, globalId: '2Curv000000000000000b',
          message: '#47 IfcStructuralCurveMember (2Curv000000000000000b): axis drift not checked: its edge could not be read; movement not checked: its derivation record could not be read' },
      ]);
      expect(text).toContain('[INF] structural-unchecked-member: Movement or axis drift was not checked on 2 of 2 linked curve member(s)');
      expect(text).toContain('[WRN] structural-unchecked-member: #47 IfcStructuralCurveMember (2Curv000000000000000b): axis drift not checked: its edge could not be read; movement not checked: its derivation record could not be read');
    } finally {
      process.exitCode = previousExitCode;
      write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('IFC4: reports the six unlinked load-bearing elements of ISSUE_171 as warnings with their GlobalIds', async (ctx) => {
    if (!existsSync(FIXTURE)) ctx.skip('ISSUE_171 fixture missing — run `pnpm fixtures`');
    const bytes = readFileSync(FIXTURE);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const issues = computeValidationIssues(await new IfcParser().parseColumnar(buffer)).filter((issue) => issue.rule.startsWith('structural-'));
    expect(issues.map((issue) => [issue.rule, issue.entityId])).toEqual([
      ...[49, 1500, 2222, 2837, 3327, 3441].map((id) => ['structural-unlinked-element', id]),
      // No axis is read for the elements its six curve members idealise, so neither geometry rule compared them (#10640).
      ['structural-unchecked-member', undefined],
      ...[2675, 2706, 2725, 2744, 2763, 2782].map((id) => ['structural-unchecked-member', id]),
    ]);
    expect(issues.find((issue) => issue.rule === 'structural-unchecked-member')?.message).toBe('Movement or axis drift was not checked on 6 of 6 linked curve member(s)');
    // All warnings but the unchecked-member headline, which counts what the per-member warnings list.
    expect(issues.filter((issue) => issue.severity !== 'warning').map((issue) => issue.message)).toEqual(['Movement or axis drift was not checked on 6 of 6 linked curve member(s)']);
    expect(issues[0].globalId).toBe('1SbQ76Ea9FQOHIEX6qOPFO');
  });
});
