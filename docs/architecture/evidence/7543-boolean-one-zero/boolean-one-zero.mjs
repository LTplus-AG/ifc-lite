/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The script from #7543 starts after the empty comment line below, unchanged.
// make-builds.mjs copies it into each build, so that its imports of
// @ifc-lite/ids load that build.
//
// node boolean-one-zero.mjs [IFC4 | IFC2X3 | IFC4X3_ADD2] [outDir]
//
// One wall with three boolean-valued properties (Flag = IFCBOOLEAN(.T.),
// Off = IFCBOOLEAN(.F.), Logical = IFCLOGICAL(.T.)) and one task with
// IsMilestone = .T. The IDS writes the same booleans as XSD allows them:
// "true", "1" and "0" (XML Schema Part 2, 3.2.2.1: the lexical space of
// xs:boolean is {true, false, 1, 0}). Writes the .ifc and .ids to outDir so
// another implementation can be run on the same files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IfcParser } from '@ifc-lite/parser';
import { auditIDSDocument, parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';

const schema = process.argv[2] ?? 'IFC4';
const outDir = process.argv[3];
const gid = (n) => String(n).padStart(22, '0');

// IfcWall has no PredefinedType in IFC2X3; IfcTask has 10 attributes there
// (TaskId at 5, IsMilestone at 8) and 13 in IFC4 / IFC4X3 (IsMilestone at 9).
const wall = schema === 'IFC2X3'
  ? `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$);`
  : `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$,$);`;
const task = schema === 'IFC2X3'
  ? `#30=IFCTASK('${gid(30)}',$,'T',$,$,'T1',$,$,.T.,$);`
  : `#30=IFCTASK('${gid(30)}',$,'T',$,$,$,$,$,$,.T.,$,$,$);`;

const ifc = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('boolean-one-zero.ifc','2026-10-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('${gid(1)}',$,'Project',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
${wall}
#11=IFCPROPERTYSINGLEVALUE('Flag',$,IFCBOOLEAN(.T.),$);
#12=IFCPROPERTYSINGLEVALUE('Off',$,IFCBOOLEAN(.F.),$);
#13=IFCPROPERTYSINGLEVALUE('Logical',$,IFCLOGICAL(.T.),$);
#20=IFCPROPERTYSET('${gid(20)}',$,'Probe_Set',$,(#11,#12,#13));
#21=IFCRELDEFINESBYPROPERTIES('${gid(21)}',$,$,$,(#10),#20);
${task}
ENDSEC;
END-ISO-10303-21;
`;

const sv = (v) => `<simpleValue>${v}</simpleValue>`;
const entity = (name) => `<entity><name>${sv(name)}</name></entity>`;
const prop = (dataType, name, value, cardinality = '') =>
  `<property${dataType ? ` dataType="${dataType}"` : ''}${cardinality ? ` cardinality="${cardinality}"` : ''}><propertySet>${sv('Probe_Set')}</propertySet><baseName>${sv(name)}</baseName><value>${value}</value></property>`;
const named = `<attribute><name>${sv('Name')}</name><value>${sv('Required')}</value></attribute>`;
const spec = (name, applicability, requirements) => `
    <specification name="${name}" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2">
      <applicability minOccurs="0" maxOccurs="unbounded">${applicability}</applicability>
      <requirements>${requirements}</requirements>
    </specification>`;

const ids = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Boolean 1 and 0</title></info>
  <specifications>${[
    spec('Flag = true (control)', entity('IFCWALL'), prop('IFCBOOLEAN', 'Flag', sv('true'))),
    spec('Flag = 1', entity('IFCWALL'), prop('IFCBOOLEAN', 'Flag', sv('1'))),
    spec('Off = 0', entity('IFCWALL'), prop('IFCBOOLEAN', 'Off', sv('0'))),
    spec('Flag = 1, optional', entity('IFCWALL'), prop('IFCBOOLEAN', 'Flag', sv('1'), 'optional')),
    spec('Flag = 1, prohibited (no dataType)', entity('IFCWALL'), prop('', 'Flag', sv('1'), 'prohibited')),
    spec('Logical = 1', entity('IFCWALL'), prop('IFCLOGICAL', 'Logical', sv('1'))),
    spec('Flag = 0 (must fail)', entity('IFCWALL'), prop('IFCBOOLEAN', 'Flag', sv('0'))),
    spec('Task IsMilestone = 1', entity('IFCTASK'), `<attribute><name>${sv('IsMilestone')}</name><value>${sv('1')}</value></attribute>`),
    spec('Walls with Flag = 1 named Required', entity('IFCWALL') + prop('IFCBOOLEAN', 'Flag', sv('1')), named),
    spec('Tasks with IsMilestone = 1 named Required', entity('IFCTASK') + `<attribute><name>${sv('IsMilestone')}</name><value>${sv('1')}</value></attribute>`, named),
  ].join('')}
  </specifications>
</ids>`;

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'boolean-one-zero.ifc'), ifc);
  writeFileSync(join(outDir, 'boolean-one-zero.ids'), ids);
}

const audit = await auditIDSDocument(ids);
const errors = audit.issues.filter((i) => i.severity === 'error');
const warnings = audit.issues.filter((i) => i.severity === 'warning');
console.log(`${schema} | audit: ${audit.status}, ${errors.length} errors, ${warnings.length} warnings${
  audit.issues.length ? ` (${[...new Set(audit.issues.map((i) => i.code))].join(', ')})` : ''}`);

const bytes = new TextEncoder().encode(ifc);
const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const modelInfo = { modelId: 'boolean-one-zero', schemaVersion: store.schemaVersion, entityCount: store.entityCount };
const report = await validateIDS(parseIDS(ids), createDataAccessor(store), modelInfo);
for (const r of report.specificationResults) {
  const failure = r.entityResults
    .flatMap((e) => e.requirementResults)
    .find((q) => q.status === 'fail');
  const why = failure ? ` (actual ${failure.actualValue ?? '?'}, expected ${failure.expectedValue ?? '?'})` : '';
  console.log(`${r.specification.name}: ${r.status}, applicable ${r.applicableCount}, failed ${r.failedCount}${why}${r.error ? `, error: ${r.error}` : ''}`);
}
