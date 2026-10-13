/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7543: writes the wall model and the two IDS of the parsed-wall tests in
// packages/ids/src/validation/boolean-one-zero.parsed-model.test.ts, so
// IfcTester can run on the same text. The text is copied from the test, with
// the types removed.
//
//   node dump-test-fixture.mjs <out dir>
//
// For each schema it writes <out dir>/<schema>/wall-sv.{ifc,ids} (simple
// values) and wall-enum.{ifc,ids} (enumerations), and the same again as
// wall-sv-p and wall-enum-p with an IfcProject and units added (see below).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2];
const gid = (n) => String(n).padStart(22, '0');
const ifc = (schema) => `ISO-10303-21;
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
const sv = (v) => `<simpleValue>${v}</simpleValue>`;
const wall = `<entity><name>${sv('IFCWALL')}</name></entity>`;
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
  <info><title>#7543</title></info>
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
const en = (...values) =>
  `<xs:restriction base="xs:boolean">${values.map((v) => `<xs:enumeration value="${v}"/>`).join('')}</xs:restriction>`;
const enumerationIds = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>#7543 enumerations</title></info>
  <specifications>${[
    spec('Flag in 1', wall, prop('IFCBOOLEAN', 'Flag', en('1'))),
    spec('Off in 0', wall, prop('IFCBOOLEAN', 'Off', en('0'))),
    spec('Flag in 0', wall, prop('IFCBOOLEAN', 'Flag', en('0'))),
    spec('Flag in 1 and 0 prohibited', wall, prop('', 'Flag', en('1', '0'), 'prohibited')),
    spec('Flag in 1 selects the wall', wall + prop('IFCBOOLEAN', 'Flag', en('1')), named),
    spec('Flag in 0 selects nothing', wall + prop('IFCBOOLEAN', 'Flag', en('0')), named),
  ].join('')}
  </specifications>
</ids>`;

for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3_ADD2']) {
  const dir = join(OUT, schema);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'wall-sv.ifc'), ifc(schema));
  writeFileSync(join(dir, 'wall-sv.ids'), ids);
  writeFileSync(join(dir, 'wall-enum.ifc'), ifc(schema));
  writeFileSync(join(dir, 'wall-enum.ids'), enumerationIds);
}

// IfcTester raises IndexError on a model without an IfcProject and units
// (it reads the project's units). These copies add the same three lines the
// issue's repro has; the wall and its properties are unchanged.
const project = `#1=IFCPROJECT('${gid(1)}',$,'Project',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
`;
for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3_ADD2']) {
  const dir = join(OUT, schema);
  const withProject = ifc(schema).replace('DATA;\n', `DATA;\n${project}`);
  writeFileSync(join(dir, 'wall-sv-p.ifc'), withProject);
  writeFileSync(join(dir, 'wall-sv-p.ids'), ids);
  writeFileSync(join(dir, 'wall-enum-p.ifc'), withProject);
  writeFileSync(join(dir, 'wall-enum-p.ids'), enumerationIds);
}
