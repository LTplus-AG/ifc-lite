/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, loadE2Cases } from './e2-dataset.mjs';
import { E4_DIR_REL, e4DatasetErrors, e5DatasetErrors, knownToSchema, loadE4Cases, loadE5Cases } from './e4-e5-datasets.mjs';
import { loadIdsToolchain, loadSchemaData } from './packages.mjs';
import { privacyFindings } from '../lib/manifest.mjs';

const ids = await loadIdsToolchain();
const schema = await loadSchemaData();
const e4 = loadE4Cases();
const e5 = loadE5Cases();

test('E4 holds at least 20 edit tasks and E5 at least 15 adversarial cases', () => {
  assert.ok(e4.length >= 20, `E4 has ${e4.length}`);
  assert.ok(e5.length >= 15, `E5 has ${e5.length}`);
  const categories = new Set(e5.map(record => record.category));
  assert.deepEqual([...categories].sort(), ['out-of-scope', 'prompt-injection', 'unknown-name']);
});

test('every E4 input and expected IDS parses, audits clean, and every edit changes the document', async () => {
  assert.deepEqual(await e4DatasetErrors(e4, ids), []);
});

test('an E4 edit that changes nothing is reported', async () => {
  const noop = { ...e4[0], expected: e4[0].input };
  const errors = await e4DatasetErrors([noop], ids);
  assert.ok(errors.some(error => error.includes('the edit changes nothing')), errors.join('\n'));
});

test('an E4 expected IDS that fails the audit is reported', async () => {
  // Built in memory: the audit must see an invented property in a standard set.
  const broken = readFileSync(join(REPO_ROOT, E4_DIR_REL, e4[0].expected), 'utf8').replace('FireRating', 'FireResistanceMinutes');
  assert.notEqual(broken, readFileSync(join(REPO_ROOT, E4_DIR_REL, e4[0].expected), 'utf8'), 'fixture assumption: the first task names FireRating');
  const audit = await ids.auditIDSDocument(broken);
  assert.ok(audit.issues.length > 0, 'the audit must reject an invented Pset_WallCommon property');
});

test('E5 cases are consistent and every invented name is absent from the IFC schema tables', async () => {
  assert.deepEqual(await e5DatasetErrors(e5, schema), []);
});

test('the schema oracle recognises real names, so it is not passing vacuously', async () => {
  assert.equal(await knownToSchema(schema, 'Pset_WallCommon'), true);
  assert.equal(await knownToSchema(schema, 'IFCSHADINGDEVICE'), true);
  assert.equal(await knownToSchema(schema, 'FireRating'), true);
  const relabelled = e5.map(record => record.category !== 'unknown-name' ? record
    : { ...record, input: { ...record.input, text: `${record.input.text} Pset_WallCommon` }, expected: { ...record.expected, mustNotEmit: ['Pset_WallCommon'] } });
  const errors = await e5DatasetErrors(relabelled, schema);
  assert.ok(errors.some(error => error.includes('Pset_WallCommon exists in the IFC schema tables')), errors.join('\n'));
});

test('an E5 case with the wrong behaviour for its category is reported', async () => {
  const wrong = { ...e5[0], expected: { ...e5[0].expected, behaviour: 'unresolved' } };
  const errors = await e5DatasetErrors([wrong], schema);
  assert.ok(errors.some(error => error.includes('expects behaviour reject')), errors.join('\n'));
});

test('no dataset carries an e-mail address or a credential-like token', () => {
  // Same scan the AI eval manifest gate applies to committed corpus files.
  const texts = [
    ...loadE2Cases().map(record => [record.id, record.description]),
    ...e4.map(record => [record.id, record.instruction]),
    ...e5.map(record => [record.id, `${record.input.text}\n${record.rationale}`]),
    ...readdirSync(join(REPO_ROOT, E4_DIR_REL, 'ids')).map(name => [name, readFileSync(join(REPO_ROOT, E4_DIR_REL, 'ids', name), 'utf8')]),
  ];
  const findings = texts.flatMap(([id, text]) => privacyFindings(text, 'text').map(finding => `${id}: ${finding}`));
  assert.deepEqual(findings, []);
});
