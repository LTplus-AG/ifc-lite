/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite validate` reports where the physical model and the structural
 * analysis model disagree (#9668). The rules are tested in `@ifc-lite/parser`;
 * this file pins that validate runs them and names the entity. Expected ids
 * come from an independent ifcopenshell pass.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { computeValidationIssues } from './validate.js';

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
    ]);
  });

  it('IFC4: reports the six unlinked load-bearing elements of ISSUE_171 as warnings with their GlobalIds', async (ctx) => {
    if (!existsSync(FIXTURE)) ctx.skip('ISSUE_171 fixture missing — run `pnpm fixtures`');
    const bytes = readFileSync(FIXTURE);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const issues = computeValidationIssues(await new IfcParser().parseColumnar(buffer)).filter((issue) => issue.rule.startsWith('structural-'));
    expect(issues.map((issue) => [issue.rule, issue.entityId])).toEqual(
      [49, 1500, 2222, 2837, 3327, 3441].map((id) => ['structural-unlinked-element', id]));
    expect(issues.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(issues[0].globalId).toBe('1SbQ76Ea9FQOHIEX6qOPFO');
  });
});
