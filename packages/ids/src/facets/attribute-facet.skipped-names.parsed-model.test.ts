/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10543 on real parsed models (IfcParser + createDataAccessor + validateIDS).
 *
 * The attribute facet used to read an entity's attributes through the
 * parser's display list, which leaves out GlobalId, OwnerHistory,
 * ObjectPlacement, Representation, HasPropertySets and RepresentationMaps.
 * So a name pattern or enumeration never found GlobalId, and none of the
 * three references could be found at all.
 *
 * Two walls, written as IFC2X3, IFC4 and IFC4X3_ADD2: W-1
 * has an owner history, a placement and a representation; W-2 has none.
 * The expected rows are IfcTester's on the same text (ifctester 0.8.3 on
 * IfcOpenShell 0.8.4, `ids.open(..., validate=True)`), with the project,
 * units and owner history the test model carries. The committed sample
 * building-architecture.ifc and a wall created in the session (an overlay
 * entity) are checked too.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { createDataAccessor } from '../bridge/index.js';
import { validateIDS } from '../validation/validator.js';

const gid = (n: number) => String(n).padStart(22, '0');

function step(schema: string): string {
  const wallTail = schema === 'IFC2X3' ? '' : ',$';
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('skipped-attribute-names.ifc','2026-11-16T00:00:00',(''),(''),'','','');",
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;',
    'DATA;',
    `#1=IFCPROJECT('${gid(1)}',#4,'Project',$,$,$,$,$,#3);`,
    '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    '#3=IFCUNITASSIGNMENT((#2));',
    '#4=IFCOWNERHISTORY(#41,#43,$,.ADDED.,$,$,$,0);',
    "#40=IFCPERSON($,$,'P',$,$,$,$,$);",
    "#42=IFCORGANIZATION($,'O',$,$,$);",
    '#41=IFCPERSONANDORGANIZATION(#40,#42,$);',
    "#43=IFCAPPLICATION(#42,'1','A','A');",
    '#5=IFCLOCALPLACEMENT($,#6);',
    '#6=IFCAXIS2PLACEMENT3D(#7,$,$);',
    '#7=IFCCARTESIANPOINT((0.,0.,0.));',
    "#8=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);",
    "#9=IFCSHAPEREPRESENTATION(#8,'Body','SweptSolid',());",
    '#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#9));',
    `#10=IFCWALL('${gid(10)}',#4,'W-1',$,$,#5,#11,$${wallTail});`,
    `#20=IFCWALL('${gid(20)}',$,'W-2',$,$,$,$,$${wallTail});`,
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');
}

const simple = (v: string) => `<simpleValue>${v}</simpleValue>`;
const pattern = (p: string) => `<xs:restriction base="xs:string"><xs:pattern value="${p}"/></xs:restriction>`;
const list = (...v: string[]) =>
  `<xs:restriction base="xs:string">${v.map((x) => `<xs:enumeration value="${x}"/>`).join('')}</xs:restriction>`;

/** [name, attribute name, value, cardinality, extra applicability facet] */
type Spec = [string, string, string?, string?, string?];

function ids(schema: string, specs: Spec[]): string {
  const body = specs
    .map(
      ([name, attrName, value = '', cardinality = 'required', extra = '']) => `
    <specification name="${name}" ifcVersion="${schema}">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name>${simple('IFCWALL')}</name></entity>${extra}</applicability>
      <requirements><attribute cardinality="${cardinality}"><name>${attrName}</name>${value}</attribute></requirements>
    </specification>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>#10543</title></info>
  <specifications>${body}
  </specifications>
</ids>`;
}

const SPECS: Spec[] = [
  ['GlobalId', simple('GlobalId')],
  ['pattern Global.*', pattern('Global.*')],
  ['enumeration {GlobalId}', list('GlobalId')],
  ['pattern Nam.*', pattern('Nam.*')],
  ['OwnerHistory', simple('OwnerHistory')],
  ['ObjectPlacement', simple('ObjectPlacement')],
  ['Representation', simple('Representation')],
  ['pattern .*Placement', pattern('.*Placement')],
  ['enumeration {ObjectPlacement, Representation}', list('ObjectPlacement', 'Representation')],
  ['ObjectPlacement, prohibited', simple('ObjectPlacement'), '', 'prohibited'],
  ['walls with an ObjectPlacement, named W-1', simple('Name'), `<value>${simple('W-1')}</value>`, 'required', `<attribute><name>${simple('ObjectPlacement')}</name></attribute>`],
  ['walls with a Global.* attribute, named W-1', simple('Name'), `<value>${simple('W-1')}</value>`, 'required', `<attribute><name>${pattern('Global.*')}</name></attribute>`],
];

/** [name, status, applicable, failed, failed wall names] as IfcTester reports them. */
const IFCTESTER: Array<[string, string, number, number, string[]]> = [
  ['GlobalId', 'pass', 2, 0, []],
  ['pattern Global.*', 'pass', 2, 0, []],
  ['enumeration {GlobalId}', 'pass', 2, 0, []],
  ['pattern Nam.*', 'pass', 2, 0, []],
  ['OwnerHistory', 'fail', 2, 1, ['W-2']],
  ['ObjectPlacement', 'fail', 2, 1, ['W-2']],
  ['Representation', 'fail', 2, 1, ['W-2']],
  ['pattern .*Placement', 'fail', 2, 1, ['W-2']],
  ['enumeration {ObjectPlacement, Representation}', 'fail', 2, 1, ['W-2']],
  ['ObjectPlacement, prohibited', 'fail', 2, 1, ['W-1']],
  ['walls with an ObjectPlacement, named W-1', 'pass', 1, 0, []],
  ['walls with a Global.* attribute, named W-1', 'fail', 2, 1, ['W-2']],
];

async function parse(text: string) {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, {
    disableWorkerScan: true,
  });
  return {
    store,
    modelInfo: { modelId: 'skipped-names', schemaVersion: String(store.schemaVersion), entityCount: 0 },
  };
}

async function rows(xml: string, accessor: ReturnType<typeof createDataAccessor>, modelInfo: { modelId: string; schemaVersion: string; entityCount: number }) {
  const report = await validateIDS(parseIDS(xml), accessor, modelInfo);
  return report.specificationResults.map((r) => [
    r.specification.name,
    r.status,
    r.applicableCount,
    r.failedCount,
    r.entityResults.filter((e) => !e.passed).map((e) => e.entityName ?? String(e.expressId)).sort(),
  ]);
}

describe('#10543: an attribute facet finds GlobalId, OwnerHistory, ObjectPlacement and Representation', () => {
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3_ADD2']) {
    it(`${schema}: names, patterns and enumerations give IfcTester's rows`, async () => {
      const { store, modelInfo } = await parse(step(schema));
      expect(await rows(ids(schema, SPECS), createDataAccessor(store), modelInfo)).toEqual(IFCTESTER);
    });
  }

  it('getAttributeNames lists the attributes a wall sets, the references and GlobalId included', async () => {
    const { store } = await parse(step('IFC4'));
    const accessor = createDataAccessor(store);
    expect(accessor.getAttributeNames?.(10)).toEqual(['GlobalId', 'OwnerHistory', 'Name', 'ObjectPlacement', 'Representation']);
    expect(accessor.getAttributeNames?.(20)).toEqual(['GlobalId', 'Name']);
  });

  it('the committed sample building-architecture.ifc: every wall has a GlobalId, a placement and a representation', async () => {
    const sample = join(dirname(fileURLToPath(import.meta.url)), '../../../../apps/viewer/public/samples/building-architecture.ifc');
    const { store, modelInfo } = await parse(readFileSync(sample, 'utf8'));
    const xml = ids('IFC4', [
      ['pattern Global.*', pattern('Global.*')],
      ['ObjectPlacement', simple('ObjectPlacement')],
      ['Representation', simple('Representation')],
    ]);
    const result = await rows(xml, createDataAccessor(store), modelInfo);
    const walls = result[0][2] as number;
    expect(walls).toBeGreaterThan(0);
    expect(result.map((r) => r.slice(0, 4))).toEqual([
      ['pattern Global.*', 'pass', walls, 0],
      ['ObjectPlacement', 'pass', walls, 0],
      ['Representation', 'pass', walls, 0],
    ]);
  });

  it('a wall created in the session (an overlay entity) is found by a Global.* pattern', async () => {
    const { store, modelInfo } = await parse(step('IFC4'));
    const accessor = createDataAccessor(store, undefined, {
      isDeleted: () => false,
      getNewEntities: () => [
        { expressId: 900, type: 'IfcWall', attributes: ['2Wall00000000000000900', null, 'W-3', null, null, null, null, null, null] },
      ],
    });
    const xml = ids('IFC4', [['pattern Global.*', pattern('Global.*')]]);
    expect(await rows(xml, accessor, modelInfo)).toEqual([['pattern Global.*', 'pass', 3, 0, []]]);
    expect(accessor.getAttributeNames?.(900)).toEqual(['GlobalId', 'Name']);
  });

  it('a created wall that sets an owner history, a placement and a representation answers as the parsed W-1', async () => {
    // The created wall sets '#4', '#5' and '#11', as the parsed W-1 does. A
    // created reference reads as the referenced STEP id, as the parser reports
    // a parsed one, so both report the same names and meet the same checks.
    const { store, modelInfo } = await parse(step('IFC4'));
    const accessor = createDataAccessor(store, undefined, {
      isDeleted: () => false,
      getNewEntities: () => [
        { expressId: 900, type: 'IfcWall', attributes: ['2Wall00000000000000900', '#4', 'W-3', null, null, '#5', '#11', null, null] },
      ],
    });
    const parsed = accessor.getAttributeNames?.(10);
    expect(parsed).toEqual(['GlobalId', 'OwnerHistory', 'Name', 'ObjectPlacement', 'Representation']);
    expect(accessor.getAttributeNames?.(900)).toEqual(parsed);
    const xml = ids('IFC4', [
      ['OwnerHistory', simple('OwnerHistory')],
      ['ObjectPlacement', simple('ObjectPlacement')],
      ['Representation', simple('Representation')],
    ]);
    expect(await rows(xml, accessor, modelInfo)).toEqual([
      ['OwnerHistory', 'fail', 3, 1, ['W-2']],
      ['ObjectPlacement', 'fail', 3, 1, ['W-2']],
      ['Representation', 'fail', 3, 1, ['W-2']],
    ]);
  });
});

describe('#10543 controls: what the display list never hid stays as it was', () => {
  it('a simple GlobalId, a Name pattern and an unset attribute answer as before', async () => {
    const { store, modelInfo } = await parse(step('IFC4'));
    const xml = ids('IFC4', [
      ['GlobalId', simple('GlobalId')],
      ['GlobalId value', simple('GlobalId'), `<value>${simple(gid(10))}</value>`],
      ['pattern Nam.*', pattern('Nam.*')],
      ['Description (unset on both)', simple('Description')],
      ['pattern Desc.* (unset on both)', pattern('Desc.*')],
    ]);
    expect(await rows(xml, createDataAccessor(store), modelInfo)).toEqual([
      ['GlobalId', 'pass', 2, 0, []],
      ['GlobalId value', 'fail', 2, 1, ['W-2']],
      ['pattern Nam.*', 'pass', 2, 0, []],
      ['Description (unset on both)', 'fail', 2, 2, ['W-1', 'W-2']],
      ['pattern Desc.* (unset on both)', 'fail', 2, 2, ['W-1', 'W-2']],
    ]);
  });

  it('getEntityName, getGlobalId and getDescription read the same values', async () => {
    const { store } = await parse(step('IFC4'));
    const accessor = createDataAccessor(store);
    expect([accessor.getGlobalId(10), accessor.getEntityName(10), accessor.getDescription(10)]).toEqual([gid(10), 'W-1', undefined]);
    expect([accessor.getGlobalId(20), accessor.getEntityName(20), accessor.getDescription(20)]).toEqual([gid(20), 'W-2', undefined]);
  });
});
