/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7537 on real parsed models (IfcParser + createDataAccessor).
 *
 * The same three walls (W-3 has no Name; W-1 and W-2 carry
 * Pset_WallCommon.IsExternal) and a door, written as IFC2X3, IFC4 and
 * IFC4X3_ADD2, and the committed sample `building-architecture.ifc`.
 * A list naming IFCWALL twice must report what the simple value IFCWALL
 * reports, also through the property index and against minOccurs/maxOccurs.
 * The controls already right on main stay as they are: distinct classes and
 * a pattern (a full scan). On IFC2X3 the per-schema walls test also covers a
 * list holding a mapping-table alias (a full scan as well).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { createDataAccessor } from '../bridge/index.js';
import { validateIDS } from '../validation/validator.js';
import type { IDSValidationReport } from '../types.js';

const gid = (n: number) => String(n).padStart(22, '0');

function step(schema: string): string {
  // IFC2X3 walls have no PredefinedType; IFC2X3 doors no PredefinedType,
  // OperationType or UserDefinedOperationType.
  const tail = (n: number) => (schema === 'IFC2X3' ? '' : ',$'.repeat(n));
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('listed-twice.ifc','2026-10-12T00:00:00',(''),(''),'','','');",
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;',
    'DATA;',
    `#1=IFCPROJECT('${gid(1)}',$,'Project',$,$,$,$,$,#3);`,
    '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    '#3=IFCUNITASSIGNMENT((#2));',
    `#10=IFCWALL('${gid(10)}',$,'W-1',$,$,$,$,$${tail(1)});`,
    `#11=IFCWALL('${gid(11)}',$,'W-2',$,$,$,$,$${tail(1)});`,
    `#12=IFCWALL('${gid(12)}',$,$,$,$,$,$,$${tail(1)});`,
    `#20=IFCDOOR('${gid(20)}',$,'D-1',$,$,$,$,$,$,$${tail(3)});`,
    "#30=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);",
    `#31=IFCPROPERTYSET('${gid(31)}',$,'Pset_WallCommon',$,(#30));`,
    `#32=IFCRELDEFINESBYPROPERTIES('${gid(32)}',$,$,$,(#10,#11),#31);`,
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');
}

async function parse(bytes: Uint8Array) {
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  const modelInfo = { modelId: 'listed-twice', schemaVersion: String(store.schemaVersion), entityCount: 0 };
  return { accessor: createDataAccessor(store), modelInfo, schemaVersion: store.schemaVersion };
}

const list = (...values: string[]) =>
  `<xs:restriction base="xs:string">${values.map((v) => `<xs:enumeration value="${v}"/>`).join('')}</xs:restriction>`;
const ANY = 'minOccurs="0" maxOccurs="unbounded"';
const NAME = '<requirements><attribute><name><simpleValue>Name</simpleValue></name></attribute></requirements>';
const GLOBAL_ID = '<requirements><attribute><name><simpleValue>GlobalId</simpleValue></name></attribute></requirements>';
const EXTERNAL =
  '<property dataType="IFCBOOLEAN"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>IsExternal</simpleValue></baseName></property>';

/** [name, entity name, occurs, requirements, extra applicability facet] */
type Spec = [string, string, string, string, string?];

function ids(specs: Spec[]): string {
  const body = specs
    .map(
      ([name, entity, occurs, requirements, extra = '']) => `
    <specification name="${name}" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2">
      <applicability ${occurs}><entity><name>${entity}</name></entity>${extra}</applicability>
      ${requirements}
    </specification>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Class listed twice</title></info>
  <specifications>${body}
  </specifications>
</ids>`;
}

/** Status, counts, cardinality message and the express ids of the rows. */
const outcome = (report: IDSValidationReport) =>
  report.specificationResults.map((r) => [
    r.specification.name,
    r.status,
    r.applicableCount,
    r.passedCount,
    r.failedCount,
    r.cardinalityResult?.passed === false ? r.cardinalityResult.message : null,
    r.entityResults.map((e) => e.expressId),
  ]);

const LISTED_TWICE: Spec[] = [
  ['IFCWALL, IFCWALL', list('IFCWALL', 'IFCWALL'), ANY, NAME],
  ['IFCWALL, IFCWALL, IFCAIRTERMINAL', list('IFCWALL', 'IFCWALL', 'IFCAIRTERMINAL'), ANY, NAME],
  ['IFCWALL, IFCWALL with IsExternal', list('IFCWALL', 'IFCWALL'), ANY, NAME, EXTERNAL],
  ['IFCWALL, IFCWALL prohibited', list('IFCWALL', 'IFCWALL'), 'minOccurs="0" maxOccurs="0"', '<requirements/>'],
  ['IFCWALL, IFCWALL maxOccurs 5', list('IFCWALL', 'IFCWALL'), 'minOccurs="0" maxOccurs="5"', GLOBAL_ID],
  ['IFCWALL, IFCWALL minOccurs 4', list('IFCWALL', 'IFCWALL'), 'minOccurs="4" maxOccurs="unbounded"', GLOBAL_ID],
];

const CONTROLS: Spec[] = [
  ['IFCWALL', '<simpleValue>IFCWALL</simpleValue>', ANY, NAME],
  ['IFCWALL, IFCDOOR', list('IFCWALL', 'IFCDOOR'), ANY, NAME],
  ['pattern IFCWALL|IFCWALL', '<xs:restriction base="xs:string"><xs:pattern value="IFCWALL|IFCWALL"/></xs:restriction>', ANY, NAME],
];

const SCHEMAS = [
  ['IFC2X3', 'IFC2X3'],
  ['IFC4', 'IFC4'],
  ['IFC4X3_ADD2', 'IFC4X3'],
] as const;

describe('a class listed twice on real parsed models (#7537)', () => {
  it.each(SCHEMAS)('%s: each wall is counted and reported once', async (schema, parsedAs) => {
    const { accessor, modelInfo, schemaVersion } = await parse(new TextEncoder().encode(step(schema)));
    expect(schemaVersion).toBe(parsedAs);

    const report = await validateIDS(parseIDS(ids(LISTED_TWICE)), accessor, modelInfo);

    expect(outcome(report)).toEqual([
      ['IFCWALL, IFCWALL', 'fail', 3, 2, 1, null, [10, 11, 12]],
      ['IFCWALL, IFCWALL, IFCAIRTERMINAL', 'fail', 3, 2, 1, null, [10, 11, 12]],
      ['IFCWALL, IFCWALL with IsExternal', 'pass', 2, 2, 0, null, [10, 11]],
      ['IFCWALL, IFCWALL prohibited', 'fail', 3, 0, 3, 'Expected at most 0, found 3', [10, 11, 12]],
      ['IFCWALL, IFCWALL maxOccurs 5', 'pass', 3, 3, 0, null, [10, 11, 12]],
      ['IFCWALL, IFCWALL minOccurs 4', 'fail', 3, 3, 0, 'Expected at least 4, found 3', [10, 11, 12]],
    ]);
  });

  it.each(SCHEMAS)('%s: simple value, distinct classes and a pattern are unchanged', async (schema) => {
    const { accessor, modelInfo } = await parse(new TextEncoder().encode(step(schema)));

    const report = await validateIDS(parseIDS(ids(CONTROLS)), accessor, modelInfo);

    expect(outcome(report)).toEqual([
      ['IFCWALL', 'fail', 3, 2, 1, null, [10, 11, 12]],
      ['IFCWALL, IFCDOOR', 'fail', 4, 3, 1, null, [10, 11, 12, 20]],
      ['pattern IFCWALL|IFCWALL', 'fail', 3, 2, 1, null, [10, 11, 12]],
    ]);
  });

  it('the committed sample building-architecture.ifc reports IFCWALL, IFCWALL as IFCWALL', async () => {
    const sample = join(dirname(fileURLToPath(import.meta.url)), '../../../../apps/viewer/public/samples/building-architecture.ifc');
    const { accessor, modelInfo } = await parse(readFileSync(sample));

    const report = await validateIDS(
      parseIDS(ids([
        ['IFCWALL', '<simpleValue>IFCWALL</simpleValue>', ANY, NAME],
        ['IFCWALL, IFCWALL', list('IFCWALL', 'IFCWALL'), ANY, NAME],
      ])),
      accessor,
      modelInfo
    );

    const [simple, twice] = outcome(report);
    expect(simple.slice(1, 5)).toEqual(['pass', 4, 4, 0]);
    expect(twice.slice(1)).toEqual(simple.slice(1));
  });
});
