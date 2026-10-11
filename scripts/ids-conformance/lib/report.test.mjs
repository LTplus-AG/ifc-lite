/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// IDS conformance dashboard (IDS-125): the published page is a pure
// rendering of the committed matrix JSON, so it cannot drift from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REGION, renderMarkdown, replaceRegion } from './report.mjs';
import { buildMatrix } from './matrix.mjs';

const DOC = fileURLToPath(new URL('../../../docs/guide/ids-conformance.md', import.meta.url));
const JSON_PATH = fileURLToPath(new URL('../../../docs/guide/ids-conformance.json', import.meta.url));

test('the committed docs region is exactly the rendering of the committed JSON', () => {
  const doc = readFileSync(DOC, 'utf8');
  const matrix = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  assert.equal(replaceRegion(doc, renderMarkdown(matrix)), doc, 'run `node scripts/ids-conformance/run.mjs` and commit both files');
});

test('the committed matrix covers the whole corpus for every engine it lists', () => {
  const matrix = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  assert.equal(matrix.schema, 'ifc-lite/ids-conformance-matrix@1');
  assert.equal(matrix.cases.length, matrix.corpus.cases);
  assert.equal(matrix.cases.length, 334);
  for (const row of matrix.cases) {
    assert.deepEqual(Object.keys(row.cells).sort(), matrix.engines.map((e) => e.id).sort(), row.id);
  }
});

test('a disagreement is listed with its detail, and agreement is scored over answered cases only', async () => {
  const cases = [
    { id: 'entity/pass-a', group: 'entity', expected: 'pass', idsPath: '', ifcPath: '' },
    { id: 'entity/invalid-b', group: 'entity', expected: 'invalid', idsPath: '', ifcPath: '' },
  ];
  const engine = { info: { id: 'e', name: 'Engine E', version: '1', licence: 'MIT', source: 's', notes: ['note one'] }, validate: async () => ({ verdict: 'fail', detail: '0 applicable' }) };
  const md = renderMarkdown(await buildMatrix(cases, [engine], { corpus: { name: 'c', licence: 'l', source: 's' } }));
  assert.match(md, /\| `entity\/pass-a` \| pass \| fail \| 0 applicable \|/);
  assert.match(md, /\| \*\*all cases\*\* \| \*\*0\/1 \(0\.0%\) · 1 n\/a\*\* \|/);
  assert.match(md, / {4}- note one/);
});

test('replaceRegion rewrites only between the markers and refuses a page without them', () => {
  const page = `intro\n<!-- BEGIN GENERATED: ${REGION} -->\nold\n<!-- END GENERATED: ${REGION} -->\noutro\n`;
  assert.equal(replaceRegion(page, 'new'), `intro\n<!-- BEGIN GENERATED: ${REGION} -->\nnew\n<!-- END GENERATED: ${REGION} -->\noutro\n`);
  assert.throws(() => replaceRegion('no markers', 'x'), /markers for region "ids-conformance" not found/);
});
