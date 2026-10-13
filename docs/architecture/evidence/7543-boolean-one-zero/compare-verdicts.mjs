/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7543: compares IFC Lite's verdicts (run-files.mjs output) with
// IfcTester's (ifctester-run.py output), row by row.
//
//   node compare-verdicts.mjs <ifctester output> <run-files output>
//
// Both files hold sections that start "=== <who> <folder>/<case>" and list
// "  <specification>: <status>, applicable <n>, failed <n>". For each IFC Lite
// build and each case, it prints how many rows differ from IfcTester, and
// which. A case that IfcTester could not run is named as such. For a case
// "<name>-p" (the same model with an IfcProject added), it also says whether
// each build gives the same rows as on "<name>".

import { readFileSync } from 'node:fs';

function sections(file) {
  const out = new Map();
  let rows;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const head = /^=== (\S+) (\S+)$/.exec(line);
    if (head) {
      const [, who, key] = head;
      if (!out.has(who)) out.set(who, new Map());
      rows = new Map();
      out.get(who).set(key, rows);
      continue;
    }
    const raised = /^ {2}raised (.*)$/.exec(line);
    if (raised && rows) { rows.set('(raised)', raised[1]); continue; }
    const row = /^ {2}(.*): ((?:pass|fail)[^:]*)$/.exec(line);
    if (row && rows) rows.set(row[1], row[2]);
  }
  return out;
}

const [testerFile, liteFile] = process.argv.slice(2);
if (!testerFile || !liteFile) {
  console.error('usage: node compare-verdicts.mjs <ifctester output> <run-files output>');
  process.exit(2);
}
const tester = sections(testerFile).get('ifctester') ?? new Map();
const lite = sections(liteFile);

for (const [who, cases] of lite) {
  for (const [key, rows] of cases) {
    const expected = tester.get(key);
    if (!expected) { console.log(`${who} ${key}: IfcTester did not run this case`); continue; }
    if (expected.has('(raised)')) { console.log(`${who} ${key}: IfcTester raised ${expected.get('(raised)')}`); continue; }
    const differ = [...expected].filter(([name, verdict]) => rows.get(name) !== verdict);
    const missing = [...rows.keys()].filter((name) => !expected.has(name));
    console.log(`${who} ${key}: differs from IfcTester on ${differ.length} of ${expected.size} rows${missing.length ? `, ${missing.length} rows IfcTester does not have` : ''}`);
    for (const [name, verdict] of differ) console.log(`    ${name}: ${rows.get(name) ?? '(missing)'}; IfcTester ${verdict}`);
  }
  for (const [key, rows] of cases) {
    if (!key.endsWith('-p')) continue;
    const plain = cases.get(key.slice(0, -2));
    if (!plain) continue;
    const same = plain.size === rows.size && [...plain].every(([name, verdict]) => rows.get(name) === verdict);
    console.log(`${who} ${key}: ${same ? 'the same rows as' : 'NOT the same rows as'} ${key.slice(0, -2)}`);
  }
}
