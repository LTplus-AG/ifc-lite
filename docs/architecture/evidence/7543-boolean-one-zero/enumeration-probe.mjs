/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7543: an xs:enumeration that lists 1 or 0, against a stored boolean.
//
//   node enumeration-probe.mjs <builds dir> <out dir> [IFC4 | IFC2X3 | IFC4X3_ADD2] [old build, default main] [new build, default head]
//
// The builds are the folders make-builds.mjs writes. Writes enumeration.ifc
// and enumeration.ids to <out dir>, so IfcTester can run on the same files
// (ifctester-run.py), and prints the audit and the verdicts of both builds.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [ROOT, OUT, schema = 'IFC4', OLD = 'main', NEW = 'head'] = process.argv.slice(2);
const SIDE = { main: OLD, branch: NEW };
const load = (b, rel) => import(pathToFileURL(join(ROOT, SIDE[b], 'dist', rel)).href);
const { IfcParser } = await import(pathToFileURL(join(ROOT, SIDE.branch, 'node_modules', '@ifc-lite', 'parser', 'dist', 'index.js')).href);

const gid = (n) => String(n).padStart(22, '0');
const wall = schema === 'IFC2X3' ? `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$);` : `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$,$);`;
const ifc = `ISO-10303-21;
HEADER;FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');FILE_NAME('enumeration.ifc','2026-10-13T00:00:00',(''),(''),'','','');FILE_SCHEMA(('${schema}'));ENDSEC;
DATA;
#1=IFCPROJECT('${gid(1)}',$,'Project',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
${wall}
#11=IFCPROPERTYSINGLEVALUE('Flag',$,IFCBOOLEAN(.T.),$);
#12=IFCPROPERTYSINGLEVALUE('Off',$,IFCBOOLEAN(.F.),$);
#13=IFCPROPERTYSINGLEVALUE('Count',$,IFCINTEGER(1),$);
#20=IFCPROPERTYSET('${gid(20)}',$,'Probe_Set',$,(#11,#12,#13));
#21=IFCRELDEFINESBYPROPERTIES('${gid(21)}',$,$,$,(#10),#20);
ENDSEC;
END-ISO-10303-21;
`;
const sv = (v) => `<simpleValue>${v}</simpleValue>`;
const en = (base, values) => `<xs:restriction base="${base}">${values.map((v) => `<xs:enumeration value="${v}"/>`).join('')}</xs:restriction>`;
const prop = (dataType, name, value, cardinality = '') =>
  `<property${dataType ? ` dataType="${dataType}"` : ''}${cardinality ? ` cardinality="${cardinality}"` : ''}><propertySet>${sv('Probe_Set')}</propertySet><baseName>${sv(name)}</baseName><value>${value}</value></property>`;
const wallEntity = `<entity><name>${sv('IFCWALL')}</name></entity>`;
const spec = (name, requirements) => `
    <specification name="${name}" ifcVersion="IFC2X3 IFC4 IFC4X3_ADD2">
      <applicability minOccurs="0" maxOccurs="unbounded">${wallEntity}</applicability>
      <requirements>${requirements}</requirements>
    </specification>`;
const ROWS = [
  ['Flag in {true} xs:boolean (control)', prop('IFCBOOLEAN', 'Flag', en('xs:boolean', ['true']))],
  ['Flag in {1} xs:boolean', prop('IFCBOOLEAN', 'Flag', en('xs:boolean', ['1']))],
  ['Flag in {0} xs:boolean (must fail)', prop('IFCBOOLEAN', 'Flag', en('xs:boolean', ['0']))],
  ['Off in {0} xs:boolean', prop('IFCBOOLEAN', 'Off', en('xs:boolean', ['0']))],
  ['Flag in {1, 0} xs:boolean', prop('IFCBOOLEAN', 'Flag', en('xs:boolean', ['1', '0']))],
  ['Flag in {1} xs:boolean, no dataType', prop('', 'Flag', en('xs:boolean', ['1']))],
  ['Flag in {1} xs:boolean, prohibited', prop('', 'Flag', en('xs:boolean', ['1']), 'prohibited')],
  ['Flag in {1} xs:string', prop('IFCBOOLEAN', 'Flag', en('xs:string', ['1']))],
  ['Flag in {true} xs:string (control)', prop('IFCBOOLEAN', 'Flag', en('xs:string', ['true']))],
  ['Flag in {1} xs:integer', prop('IFCBOOLEAN', 'Flag', en('xs:integer', ['1']))],
  ['Flag in {0, 1, 2} xs:integer', prop('IFCBOOLEAN', 'Flag', en('xs:integer', ['0', '1', '2']))],
  ['Off in {0} xs:integer', prop('IFCBOOLEAN', 'Off', en('xs:integer', ['0']))],
  ['Count (IFCINTEGER 1) in {1} xs:integer (control)', prop('IFCINTEGER', 'Count', en('xs:integer', ['1']))],
  ['Count (IFCINTEGER 1) in {true} xs:boolean (control)', prop('', 'Count', en('xs:boolean', ['true']))],
];
const ids = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Enumerations with 1 and 0</title></info>
  <specifications>${ROWS.map(([n, r]) => spec(n, r)).join('')}
  </specifications>
</ids>`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'enumeration.ifc'), ifc);
writeFileSync(join(OUT, 'enumeration.ids'), ids);

const bytes = new TextEncoder().encode(ifc);
const warn = console.warn; console.warn = () => {};
const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0), { disableWorkerScan: true });
console.warn = warn;
for (const b of ['main', 'branch']) {
  const { auditIDSDocument, parseIDS, validateIDS } = await load(b, 'index.js');
  const { createDataAccessor } = await load(b, 'bridge/index.js');
  const audit = await auditIDSDocument(ids);
  console.log(`${SIDE[b]} ${schema} | audit: ${audit.status}, ${audit.issues.length} issues`);
  for (const i of audit.issues) {
    const k = /^specifications\[(\d+)\]/.exec(i.path ?? '')?.[1];
    console.log(`  audit ${i.severity} ${i.code} on "${k === undefined ? i.path : ROWS[Number(k)][0]}"`);
  }
  const report = await validateIDS(parseIDS(ids), createDataAccessor(store), { modelId: 'enumeration', schemaVersion: store.schemaVersion, entityCount: store.entityCount });
  for (const r of report.specificationResults) console.log(`  ${r.specification.name}: ${r.status}, applicable ${r.applicableCount}, failed ${r.failedCount}`);
}
