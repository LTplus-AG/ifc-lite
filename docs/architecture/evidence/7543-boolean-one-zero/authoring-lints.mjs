/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7543: what the @ifc-lite/ids-authoring lints say about 1 and true on an
// IFCBOOLEAN property, beside what the checker does with the same IDS.
//
//   node authoring-lints.mjs <builds dir> <build>
//
// Needs packages/ids-authoring/dist (pnpm --filter @ifc-lite/ids-authoring build).
// The imports of @ifc-lite/ids, from that dist and from this script, are sent
// to <builds dir>/<build>/dist (a folder make-builds.mjs writes), so the lints
// and the checker use the same build. Each case lints its IDS with one rule
// only, as the package's own lint tests do, and then validates the same IDS
// against a parsed IFC4 wall whose Pset_WallCommon.IsExternal is
// IFCBOOLEAN(.T.).

import { register } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [ROOT, BUILD] = process.argv.slice(2);
if (!ROOT || !BUILD) {
  console.error('usage: node authoring-lints.mjs <builds dir> <build>');
  process.exit(2);
}
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const dist = pathToFileURL(join(resolve(ROOT, BUILD), 'dist')).href;
const MAP = { '@ifc-lite/ids': `${dist}/index.js`, '@ifc-lite/ids/bridge': `${dist}/bridge/index.js` };
register(`data:text/javascript,${encodeURIComponent(`
const MAP = ${JSON.stringify(MAP)};
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(MAP, specifier)) return { url: MAP[specifier], shortCircuit: true };
  return next(specifier, context);
}`)}`);

const { parseIDS, validateIDS } = await import('@ifc-lite/ids');
const { createDataAccessor } = await import('@ifc-lite/ids/bridge');
const authoring = await import(pathToFileURL(join(REPO, 'packages', 'ids-authoring', 'dist', 'index.js')).href);
const parserUrl = pathToFileURL(join(resolve(ROOT, BUILD), 'node_modules', '@ifc-lite', 'parser', 'dist', 'index.js')).href;
const { IfcParser } = await import(parserUrl);

// The IDS helpers of packages/ids-authoring/test/lint-helpers.ts, without types.
const NS = 'xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const idsXml = (specs) => `<?xml version="1.0" encoding="UTF-8"?><ids ${NS}><info><title>Fixture</title></info><specifications>${specs}</specifications></ids>`;
const specXml = (app, req = '', name = 'S') =>
  `<specification name="${name}" ifcVersion="IFC4"><applicability minOccurs="0" maxOccurs="unbounded">${app}</applicability>${req ? `<requirements>${req}</requirements>` : ''}</specification>`;
const sv = (v) => `<simpleValue>${v}</simpleValue>`;
const entity = (name) => `<entity><name>${sv(name)}</name></entity>`;
const enumeration = (values, base) => `<xs:restriction base="${base}">${values.map((v) => `<xs:enumeration value="${v}"/>`).join('')}</xs:restriction>`;
const attribute = (name) => `<attribute><name>${sv(name)}</name></attribute>`;
const external = (value) =>
  `<property dataType="IFCBOOLEAN"><propertySet>${sv('Pset_WallCommon')}</propertySet><baseName>${sv('IsExternal')}</baseName><value>${value}</value></property>`;

const W = entity('IFCWALL');
const one = (app, req) => idsXml(specXml(app, req));
const CASES = [
  ['IDSL-SPEC-001', 'applicability true, requirement 1', one(W + external(sv('true')), external(sv('1')))],
  ['IDSL-SPEC-001', 'applicability true, requirement true (control)', one(W + external(sv('true')), external(sv('true')))],
  ['IDSL-SPEC-002', 'applicability true, requirement 1', one(W + external(sv('true')), external(sv('1')))],
  ['IDSL-SPEC-002', 'applicability 1, requirement true', one(W + external(sv('1')), external(sv('true')))],
  ['IDSL-SPEC-002', 'requirements true and 1', one(W, external(sv('true')) + external(sv('1')))],
  ['IDSL-SPEC-002', 'applicability enumeration {1} (xs:boolean), requirement true', one(W + external(enumeration(['1'], 'xs:boolean')), external(sv('true')))],
  ['IDSL-SPEC-002', 'applicability true, requirement false (control)', one(W + external(sv('true')), external(sv('false')))],
  ['IDSL-SPEC-003', 'applicability true and 1, requirement Name', one(W + external(sv('true')) + external(sv('1')), attribute('Name'))],
  ['IDSL-SPEC-003', 'applicability true and false, requirement Name (control)', one(W + external(sv('true')) + external(sv('false')), attribute('Name'))],
  ['IDSL-SPEC-006', 'specification A requires true, B requires 1', idsXml(specXml(W, external(sv('true')), 'A') + specXml(W, external(sv('1')), 'B'))],
  ['IDSL-SPEC-006', 'specification A requires true, B requires false (control)', idsXml(specXml(W, external(sv('true')), 'A') + specXml(W, external(sv('false')), 'B'))],
  ['IDSL-VAL-005', 'requirement 1', one(W, external(sv('1')))],
];

const gid = (n) => String(n).padStart(22, '0');
const ifc = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('wall','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('${gid(1)}',$,'Project',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$,$);
#11=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#20=IFCPROPERTYSET('${gid(20)}',$,'Pset_WallCommon',$,(#11));
#21=IFCRELDEFINESBYPROPERTIES('${gid(21)}',$,$,$,(#10),#20);
ENDSEC;
END-ISO-10303-21;
`;
const bytes = new TextEncoder().encode(ifc);
const { warn, log } = console;
console.warn = () => {};
console.log = () => {};
let store;
try {
  store = await new IfcParser().parseColumnar(bytes.buffer.slice(0), { disableWorkerScan: true });
} finally {
  console.warn = warn;
  console.log = log;
}

const ctx = await authoring.createLintContext();
console.log(`@ifc-lite/ids build: ${BUILD}`);
for (const [code, label, xml] of CASES) {
  const doc = authoring.fromIdsDocument(parseIDS(xml));
  const findings = authoring.createLinter(ctx, { rules: [code] }).lint(doc).diagnostics;
  const report = await validateIDS(parseIDS(xml), createDataAccessor(store), {
    modelId: 'wall', schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  });
  console.log(`${code} | ${label}`);
  console.log(`  lint: ${findings.length ? findings.map((d) => `${d.severity}: ${d.message}`).join(' / ') : 'no finding'}`);
  for (const r of report.specificationResults) {
    console.log(`  checker, specification ${r.specification.name}: ${r.status}, applicable ${r.applicableCount}, failed ${r.failedCount}`);
  }
}
