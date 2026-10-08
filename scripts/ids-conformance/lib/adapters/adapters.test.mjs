/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// IDS conformance dashboard (IDS-125): the parts of the adapters that are
// ours, tested without installing any third-party engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCommandAdapter, parseVerdict } from './command.mjs';
import { UnsupportedCase } from '../matrix.mjs';

function config(body) {
  const dir = mkdtempSync(join(tmpdir(), 'ids-engine-'));
  const path = join(dir, 'engine.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const BASE = { id: 'echo', name: 'Echo', version: '1', licence: 'MIT', source: 'test' };

test('a command adapter passes the case paths as argv and reads the JSON verdict', async () => {
  const script = 'const [ids, ifc] = process.argv.slice(1); console.log("noise"); console.log(JSON.stringify({ verdict: ids.endsWith("p.ids") && ifc.endsWith("p.ifc") ? "pass" : "fail" }))';
  const adapter = createCommandAdapter(config({ ...BASE, validate: [process.execPath, '-e', script, '{ids}', '{ifc}'] }));
  assert.equal(await adapter.validate({ id: 'x', idsPath: '/c/p.ids', ifcPath: '/c/p.ifc' }), 'pass');
  assert.equal(await adapter.validate({ id: 'x', idsPath: '/c/q.ids', ifcPath: '/c/q.ifc' }), 'fail');
  assert.equal(adapter.audit, undefined);
});

test('a failing command is an error, never a verdict', async () => {
  const adapter = createCommandAdapter(config({ ...BASE, audit: [process.execPath, '-e', 'process.exit(3)'] }));
  await assert.rejects(adapter.audit({ id: 'x', idsPath: 'a', ifcPath: 'b' }), /failed/);
});

test('verdict parsing accepts only the question\'s answers', () => {
  assert.equal(parseVerdict('{"verdict":"invalid"}\n', ['valid', 'invalid']), 'invalid');
  assert.throws(() => parseVerdict('{"verdict":"pass"}', ['valid', 'invalid']), /not one of valid, invalid/);
  assert.throws(() => parseVerdict('Traceback', ['pass', 'fail']), /not JSON/);
  assert.throws(() => parseVerdict('{"verdict":"unsupported","reason":"IFC4X3"}', ['pass', 'fail']), (err) => err instanceof UnsupportedCase && err.message === 'IFC4X3');
});

test('a command engine config is validated up front', () => {
  assert.throws(() => createCommandAdapter(config({ ...BASE })), /needs "validate", "audit" or both/);
  assert.throws(() => createCommandAdapter(config({ ...BASE, id: 'Bad Id', audit: ['x'] })), /"id" must match/);
  assert.throws(() => createCommandAdapter(config({ ...BASE, validate: 'x' })), /non-empty array of strings/);
});
