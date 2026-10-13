/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #ISSUE on parsed models: a boolean written as `1` or `0` (the xs:boolean
 * lexical space is {true, false, 1, 0}) must match the IFCBOOLEAN value the
 * parser reads, in a requirement and in an applicability, under every schema.
 *
 * Two kinds of model:
 * - buildingSMART's own corpus pairs for booleans (property 2/3, attribute
 *   3/3: a `.F.` value checked with `false`), with `false` swapped for `0`
 *   (must pass) and for `1` (must fail);
 * - a synthetic wall per schema, where an applicability on `Flag = 1` goes
 *   through `validateIDS` and its applicability property index, and where a
 *   prohibited `Flag = 1` (no dataType) passed the wall on main although the
 *   wall holds that value;
 * - a synthetic task (IFC4, IFC4X3_ADD2), where an attribute applicability
 *   on `IsMilestone = 0` selected nothing on main.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from './validator.js';
import type { IDSValidationReport } from '../types.js';

// Vitest runs in packages/ids and may rewrite import.meta.url to a data URL.
const CORPUS = resolve(process.cwd(), 'src/__corpus__/buildingsmart-ids');

async function validate(ifcText: string, idsText: string): Promise<IDSValidationReport> {
  const bytes = new TextEncoder().encode(ifcText);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0), { disableWorkerScan: true });
  return validateIDS(parseIDS(idsText), createDataAccessor(store), {
    modelId: 'boolean-one-zero', schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  });
}

/** The corpus pair with its single `<simpleValue>false</simpleValue>` replaced by `literal`. */
async function corpusWith(pair: string, literal: string): Promise<IDSValidationReport> {
  const ids = readFileSync(resolve(CORPUS, `${pair}.ids`), 'utf-8');
  const original = '<simpleValue>false</simpleValue>';
  expect(ids.split(original).length - 1).toBe(1);
  const ifc = readFileSync(resolve(CORPUS, `${pair}.ifc`), 'utf-8');
  return validate(ifc, ids.replace(original, `<simpleValue>${literal}</simpleValue>`));
}

const verdict = (r: IDSValidationReport['specificationResults'][number]) =>
  `${r.status}, applicable ${r.applicableCount}, failed ${r.failedCount}`;

describe('buildingSMART boolean corpus pairs with 0 and 1 (#ISSUE)', () => {
  const PAIRS = [
    'property/pass-booleans_must_be_specified_as_lowercase_strings_2_3',
    'attribute/pass-booleans_must_be_specified_as_lowercase_strings_3_3',
  ];

  it.each(PAIRS)('%s: false (control) and 0 pass, 1 fails', async (pair) => {
    expect(verdict((await corpusWith(pair, 'false')).specificationResults[0])).toBe('pass, applicable 1, failed 0');
    expect(verdict((await corpusWith(pair, '0')).specificationResults[0])).toBe('pass, applicable 1, failed 0');
    expect(verdict((await corpusWith(pair, '1')).specificationResults[0])).toBe('fail, applicable 1, failed 1');
  });
});

describe('a parsed wall with Flag = IFCBOOLEAN(.T.) under each schema (#ISSUE)', () => {
  const gid = (n: number) => String(n).padStart(22, '0');
  const ifc = (schema: string) => `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('${schema}'));ENDSEC;
DATA;
#10=${schema === 'IFC2X3' ? `IFCWALL('${gid(10)}',$,'W',$,$,$,$,$)` : `IFCWALL('${gid(10)}',$,'W',$,$,$,$,$,$)`};
#11=IFCPROPERTYSINGLEVALUE('Flag',$,IFCBOOLEAN(.T.),$);
#12=IFCPROPERTYSINGLEVALUE('Off',$,IFCBOOLEAN(.F.),$);
#13=IFCPROPERTYSINGLEVALUE('Logical',$,IFCLOGICAL(.T.),$);
#20=IFCPROPERTYSET('${gid(20)}',$,'Probe_Set',$,(#11,#12,#13));
#21=IFCRELDEFINESBYPROPERTIES('${gid(21)}',$,$,$,(#10),#20);
ENDSEC;
END-ISO-10303-21;
`;
  const sv = (v: string) => `<simpleValue>${v}</simpleValue>`;
  const wall = `<entity><name>${sv('IFCWALL')}</name></entity>`;
  const prop = (dataType: string, name: string, value: string, cardinality = 'required') =>
    `<property${dataType ? ` dataType="${dataType}"` : ''} cardinality="${cardinality}"><propertySet>${sv('Probe_Set')}</propertySet><baseName>${sv(name)}</baseName><value>${value}</value></property>`;
  const named = `<attribute><name>${sv('Name')}</name><value>${sv('Required')}</value></attribute>`;
  const spec = (name: string, applicability: string, requirements: string) => `
    <specification name="${name}" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2">
      <applicability minOccurs="0" maxOccurs="unbounded">${applicability}</applicability>
      <requirements>${requirements}</requirements>
    </specification>`;
  const ids = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>#ISSUE</title></info>
  <specifications>${[
    spec('Flag = 1', wall, prop('IFCBOOLEAN', 'Flag', sv('1'))),
    spec('Off = 0', wall, prop('IFCBOOLEAN', 'Off', sv('0'))),
    spec('Flag = 1 optional', wall, prop('IFCBOOLEAN', 'Flag', sv('1'), 'optional')),
    spec('Flag = 1 prohibited', wall, prop('', 'Flag', sv('1'), 'prohibited')),
    spec('Logical = 1', wall, prop('IFCLOGICAL', 'Logical', sv('1'))),
    spec('Flag = 0', wall, prop('IFCBOOLEAN', 'Flag', sv('0'))),
    spec('Flag = 1 selects the wall', wall + prop('IFCBOOLEAN', 'Flag', sv('1')), named),
    spec('Flag = 0 selects nothing', wall + prop('IFCBOOLEAN', 'Flag', sv('0')), named),
  ].join('')}
  </specifications>
</ids>`;

  it.each(['IFC2X3', 'IFC4', 'IFC4X3_ADD2'])('%s', async (schema) => {
    const report = await validate(ifc(schema), ids);
    expect(Object.fromEntries(report.specificationResults.map((r) => [r.specification.name, verdict(r)]))).toEqual({
      'Flag = 1': 'pass, applicable 1, failed 0',
      'Off = 0': 'pass, applicable 1, failed 0',
      'Flag = 1 optional': 'pass, applicable 1, failed 0',
      // The wall holds Flag = true, so a prohibited Flag = 1 must fail it; on
      // main 1 matched nothing, so the prohibition passed the wall.
      'Flag = 1 prohibited': 'fail, applicable 1, failed 1',
      'Logical = 1': 'pass, applicable 1, failed 0',
      'Flag = 0': 'fail, applicable 1, failed 1',
      // The wall is named W, so once selected it must fail; on main it was
      // never selected and the specification passed with nothing applicable.
      'Flag = 1 selects the wall': 'fail, applicable 1, failed 1',
      'Flag = 0 selects nothing': 'pass, applicable 0, failed 0',
    });
  });
});

describe('a parsed task with IsMilestone = IFCBOOLEAN(.F.) (#ISSUE)', () => {
  const gid = (n: number) => String(n).padStart(22, '0');
  // IFC4 and IFC4X3 IfcTask: GlobalId, OwnerHistory, Name, Description, ObjectType,
  // Identification, LongDescription, Status, WorkMethod, IsMilestone, Priority,
  // TaskTime, PredefinedType.
  const ifc = (schema: string) => `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('${schema}'));ENDSEC;
DATA;
#30=IFCTASK('${gid(30)}',$,'T',$,$,$,$,$,$,.F.,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;
  const sv = (v: string) => `<simpleValue>${v}</simpleValue>`;
  const milestone = (value: string) => `<attribute><name>${sv('IsMilestone')}</name><value>${sv(value)}</value></attribute>`;
  const ids = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>#ISSUE</title></info>
  <specifications>
    <specification name="IsMilestone = 0 selects the task" ifcVersion="IFC4 IFC4X3_ADD2">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name>${sv('IFCTASK')}</name></entity>${milestone('0')}</applicability>
      <requirements><attribute><name>${sv('Name')}</name><value>${sv('Required')}</value></attribute></requirements>
    </specification>
    <specification name="IsMilestone = 1 selects nothing" ifcVersion="IFC4 IFC4X3_ADD2">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name>${sv('IFCTASK')}</name></entity>${milestone('1')}</applicability>
      <requirements><attribute><name>${sv('Name')}</name><value>${sv('Required')}</value></attribute></requirements>
    </specification>
  </specifications>
</ids>`;

  it.each(['IFC4', 'IFC4X3_ADD2'])('%s', async (schema) => {
    const report = await validate(ifc(schema), ids);
    expect(Object.fromEntries(report.specificationResults.map((r) => [r.specification.name, verdict(r)]))).toEqual({
      // The task is named T, so once selected it must fail; on main it was
      // never selected and the specification passed with nothing applicable.
      'IsMilestone = 0 selects the task': 'fail, applicable 1, failed 1',
      'IsMilestone = 1 selects nothing': 'pass, applicable 0, failed 0',
    });
  });
});
