/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// IDS conformance dashboard (IDS-125): the matrix counts what engines answer
// and nothing else. Fake adapters stand in for engines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildMatrix, runCell, UnsupportedCase } from './matrix.mjs';
import { discoverCorpus } from './corpus.mjs';

const CORPUS = fileURLToPath(new URL('../../../packages/ids/src/__corpus__/buildingsmart-ids', import.meta.url));

const cases = [
  { id: 'entity/pass-a', group: 'entity', expected: 'pass', idsPath: 'a.ids', ifcPath: 'a.ifc' },
  { id: 'entity/fail-b', group: 'entity', expected: 'fail', idsPath: 'b.ids', ifcPath: 'b.ifc' },
  { id: 'property/invalid-c', group: 'property', expected: 'invalid', idsPath: 'c.ids', ifcPath: 'c.ifc' },
];
const meta = { corpus: { name: 'fake', licence: 'none', source: 'test' } };
const info = (id) => ({ id, name: id, version: '0', licence: 'MIT', source: 'test' });

test('discovers the vendored corpus: 187 pass, 120 fail, 27 invalid', () => {
  const found = discoverCorpus(CORPUS);
  const count = (x) => found.filter((c) => c.expected === x).length;
  assert.deepEqual([found.length, count('pass'), count('fail'), count('invalid')], [334, 187, 120, 27]);
  assert.ok(found.every((c) => c.id === `${c.group}/${c.expected}-${c.id.split(`/${c.expected}-`)[1]}`));
});

test('refuses a corpus file with an unknown prefix instead of skipping it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ids-corpus-'));
  mkdirSync(join(root, 'entity'));
  writeFileSync(join(root, 'entity', 'maybe-x.ids'), '');
  assert.throws(() => discoverCorpus(root), /unrecognised corpus prefix: entity\/maybe-x\.ids/);
});

test('an agreeing, a disagreeing, an unsupported and a crashing answer are four different cells', async () => {
  const adapter = {
    info: info('e'),
    async validate({ id }) {
      if (id === 'entity/pass-a') return 'pass';
      return { verdict: 'pass', detail: 'why' };
    },
  };
  assert.deepEqual(await runCell(cases[0], adapter), { verdict: 'pass', agrees: true });
  assert.deepEqual(await runCell(cases[1], adapter), { verdict: 'pass', agrees: false, detail: 'why' });
  // No audit capability: an invalid- case is n/a, never a disagreement.
  assert.deepEqual(await runCell(cases[2], adapter), { verdict: 'n/a', agrees: null, detail: 'engine has no document audit' });
  const unsupported = { info: info('u'), validate: async () => { throw new UnsupportedCase('needs IFC4X3'); } };
  assert.deepEqual(await runCell(cases[0], unsupported), { verdict: 'n/a', agrees: null, detail: 'needs IFC4X3' });
  const crashing = { info: info('c'), validate: async () => { throw new TypeError('boom'); } };
  assert.deepEqual(await runCell(cases[0], crashing), { verdict: 'error', agrees: false, detail: 'boom' });
});

test('an audit agrees with an invalid- case only by rejecting it', async () => {
  const lenient = { info: info('l'), audit: async () => 'valid' };
  const strict = { info: info('s'), audit: async () => 'invalid' };
  assert.equal((await runCell(cases[2], lenient)).agrees, false);
  assert.equal((await runCell(cases[2], strict)).agrees, true);
});

test('summaries tally per engine, per facet and per expected verdict', async () => {
  const perfect = { info: info('perfect'), validate: async ({ id }) => (id.includes('pass-') ? 'pass' : 'fail'), audit: async () => 'invalid' };
  const flaky = { info: info('flaky'), validate: async ({ id }) => { if (id.includes('fail-')) throw new Error('x'); return 'fail'; } };
  const matrix = await buildMatrix(cases, [perfect, flaky], meta);
  assert.deepEqual(matrix.summary.perfect.overall, { agree: 3, disagree: 0, error: 0, na: 0 });
  assert.deepEqual(matrix.summary.flaky.overall, { agree: 0, disagree: 1, error: 1, na: 1 });
  assert.deepEqual(matrix.summary.flaky.byGroup.entity, { agree: 0, disagree: 1, error: 1, na: 0 });
  assert.deepEqual(matrix.summary.flaky.byExpected.invalid, { agree: 0, disagree: 0, error: 0, na: 1 });
  assert.deepEqual(matrix.engines.map((e) => e.id), ['perfect', 'flaky']);
  assert.equal(matrix.cases.length, 3);
});
