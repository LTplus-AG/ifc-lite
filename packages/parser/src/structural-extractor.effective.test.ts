/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { ColumnarParser } from './columnar-parser.js';
import { StepTokenizer } from './tokenizer.js';
import { extractStructuralOnDemand } from './structural-extractor.js';
import type { StructuralExtractionView } from './structural-extractor.js';

async function parse(step: string) {
  const source = new TextEncoder().encode(step);
  const refs = [...new StepTokenizer(source).scanEntitiesFast()].map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  return new ColumnarParser().parseLite(source.buffer.slice(0), refs, {});
}

const STEP = `ISO-10303-21;HEADER;FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');FILE_NAME('test.ifc','2026-01-01T00:00:00',('a'),('a'),'','', '');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCSTRUCTURALMEMBER('MemberGuid00000000001',$,'Source member',$,$);
ENDSEC;END-ISO-10303-21;`;

function view(overrides: Partial<StructuralExtractionView> = {}): StructuralExtractionView {
  return {
    isDeleted: () => false,
    getNewEntities: () => [],
    ...overrides,
  };
}

describe('extractStructuralOnDemand effective membership (#5236)', () => {
  it('omits a deleted source structural entity', async () => {
    const store = await parse(STEP);
    const result = extractStructuralOnDemand(store, view({ isDeleted: (id) => id === 1 }));
    expect(result.members).toEqual([]);
    expect(result.hasStructural).toBe(false);
  });

  it('includes a session-created structural entity', async () => {
    const store = await parse(STEP.replace('#1=IFCSTRUCTURALMEMBER', '#2=IFCSTRUCTURALMEMBER').replace('MemberGuid00000000001', 'MemberGuid00000000002'));
    const result = extractStructuralOnDemand(store, view({
      getNewEntities: () => [{ expressId: 99, type: 'IFCSTRUCTURALMEMBER' }],
      getNewEntity: (id) => id === 99
        ? { type: 'IFCSTRUCTURALMEMBER', attributes: ['CreatedGuid00000000001', null, 'Created member', null, null] }
        : null,
    }));
    expect(result.members.map((member) => [member.expressId, member.name])).toContainEqual([99, 'Created member']);
    expect(result.hasStructural).toBe(true);
  });

  it('uses an entity retyped into a structural member and filters its old class', async () => {
    const store = await parse(STEP.replace('IFCSTRUCTURALMEMBER', 'IFCWALL'));
    const result = extractStructuralOnDemand(store, view({
      getTypeMutations: () => new Map([[1, { newType: 'IFCSTRUCTURALMEMBER' }]]),
    }));
    expect(result.members.map((member) => member.expressId)).toEqual([1]);
  });

  it('reads an edited source relationship endpoint (#5236)', async () => {
    const step = STEP.replace(
      "#1=IFCSTRUCTURALMEMBER('MemberGuid00000000001',$,'Source member',$,$);",
      "#1=IFCSTRUCTURALMEMBER('MemberGuid00000000001',$,'Source member',$,$);\n" +
        "#2=IFCSTRUCTURALCONNECTION('ConnectionGuid000000001',$,'Old connection',$,$);\n" +
        "#3=IFCSTRUCTURALCONNECTION('ConnectionGuid000000002',$,'Edited connection',$,$);\n" +
        "#4=IFCRELCONNECTSSTRUCTURALMEMBER('RelationGuid00000000001',$,$,$,#1,#2);",
    );
    const store = await parse(step);
    const result = extractStructuralOnDemand(store, view({
      readEntity: (id, type, source) => id === 4 && source
        ? { ...source, type, attrs: [...source.attrs.slice(0, 5), 3] }
        : source,
    }));
    expect(result.members[0]?.connectionGlobalIds).toEqual(['ConnectionGuid000000002']);
    expect(result.connections.find((connection) => connection.expressId === 3)?.memberGlobalIds)
      .toEqual(['MemberGuid00000000001']);
  });

  it('reads physical links when the view returns STEP-cased types', async () => {
    const step = STEP.replace(
      "#1=IFCSTRUCTURALMEMBER('MemberGuid00000000001',$,'Source member',$,$);",
      "#1=IFCSTRUCTURALCURVEMEMBER('MemberGuid00000000001',$,'Source member',$,$,$,$,.RIGID_JOINED_MEMBER.,$);\n" +
        "#8=IFCBEAM('BeamGuid0000000000001',$,$,$,$,$,$,$,$);\n" +
        "#10=IFCRELASSIGNSTOPRODUCT('AssignGuid000000000001',$,$,$,(#1),.PRODUCT.,#8);",
    );
    const result = extractStructuralOnDemand(await parse(step), view({
      readEntity: (_id, type, source) => (source ? { ...source, type } : source),
    }));
    expect(result.members[0]?.physicalElementIds).toEqual([8]);
  });

  it('does not resurrect session-deleted physical products, relation resources or connections', async () => {
    const step = STEP.replace(
      "#1=IFCSTRUCTURALMEMBER('MemberGuid00000000001',$,'Source member',$,$);",
      "#1=IFCSTRUCTURALCURVEMEMBER('MemberGuid00000000001',$,'Source member',$,$,$,$,.RIGID_JOINED_MEMBER.,$);\n" +
        "#2=IFCSTRUCTURALPOINTCONNECTION('ConnectionGuid000000001',$,'Kept',$,$,$,$,$,$);\n" +
        "#3=IFCSTRUCTURALPOINTCONNECTION('ConnectionGuid000000002',$,'Deleted',$,$,$,$,$,$);\n" +
        "#4=IFCRELCONNECTSWITHECCENTRICITY('RelationGuid00000000001',$,$,$,#1,#2,#5,$,$,$,#6);\n" +
        "#7=IFCRELCONNECTSSTRUCTURALMEMBER('RelationGuid00000000002',$,$,$,#1,#3,$,$,$,$);\n" +
        "#5=IFCBOUNDARYNODECONDITION('Release',$,$,$,$,$,$);\n" +
        "#6=IFCCONNECTIONPOINTECCENTRICITY($,$,1.,2.,3.);\n" +
        "#8=IFCBEAM('BeamGuid0000000000001',$,$,$,$,$,$,$,$);\n" +
        "#9=IFCBEAM('BeamGuid0000000000002',$,$,$,$,$,$,$,$);\n" +
        "#10=IFCRELASSIGNSTOPRODUCT('AssignGuid000000000001',$,$,$,(#1),.PRODUCT.,#8);\n" +
        "#11=IFCRELASSIGNSTOPRODUCT('AssignGuid000000000002',$,$,$,(#1),.PRODUCT.,#9);",
    );
    const deleted = new Set([3, 5, 6, 9]);
    const result = extractStructuralOnDemand(await parse(step), view({
      isDeleted: (id) => deleted.has(id),
      readEntity: (id, _type, source) => (deleted.has(id) ? undefined : source),
    }));
    const member = result.members[0];
    expect(member?.physicalElementIds).toEqual([8]);
    expect(member?.connectionGlobalIds).toEqual(['ConnectionGuid000000001']);
    expect(member?.IfcRelConnectsStructuralMember).toEqual([{ expressId: 4, RelatedStructuralConnection: 2 }]);
  });
});
