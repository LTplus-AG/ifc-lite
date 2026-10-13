/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7543: validate <dir>/<case>.ifc against <dir>/<case>.ids with one build
// of @ifc-lite/ids (a folder make-builds.mjs writes).
//
//   node run-files.mjs <builds dir> <build> <dir> <case> [<case> ...]
//
// Prints "  <spec>: <status>, applicable <n>, failed <n>" per specification,
// the same form ifctester-run.py prints, so the two outputs can be diffed.
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [ROOT, BUILD, DIR, ...CASES] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(ROOT, BUILD, 'dist', rel)).href);
const { IfcParser } = await import(pathToFileURL(join(ROOT, BUILD, 'node_modules', '@ifc-lite', 'parser', 'dist', 'index.js')).href);
const { parseIDS, validateIDS } = await load('index.js');
const { createDataAccessor } = await load('bridge/index.js');

for (const c of CASES) {
  const bytes = new Uint8Array(readFileSync(join(DIR, `${c}.ifc`)));
  const warn = console.warn; const log = console.log; console.warn = () => {}; console.log = () => {};
  let store;
  try { store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true }); }
  finally { console.warn = warn; console.log = log; }
  const report = await validateIDS(parseIDS(readFileSync(join(DIR, `${c}.ids`), 'utf-8')), createDataAccessor(store), {
    modelId: c, schemaVersion: store.schemaVersion, entityCount: store.entityCount,
  });
  console.log(`=== ${BUILD} ${basename(resolve(DIR))}/${c}`);
  for (const r of report.specificationResults) console.log(`  ${r.specification.name}: ${r.status}, applicable ${r.applicableCount}, failed ${r.failedCount}`);
}
