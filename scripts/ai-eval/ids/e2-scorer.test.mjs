/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, loadE2Cases } from './e2-dataset.mjs';
import { createE2Scorer, summariseE2 } from './e2-scorer.mjs';

const cases = loadE2Cases();
const byId = new Map(cases.map(record => [record.id, record]));
const corpusIds = record => readFileSync(join(REPO_ROOT, record.corpusIds), 'utf8');
const scorer = await createE2Scorer();

/**
 * Corpus IDS files that are conforming IDS (they are `pass-`/`fail-` cases,
 * not `invalid-`), but that our audit reports with errors today. Measured,
 * not derived. Three families: user-defined predefined types
 * (E_IFC_PREDEF_TYPE_INVALID), the IFC2X3 air-terminal type mapping
 * (E_IFC_ENTITY_UNKNOWN), and a classification on a material
 * (E_IFC_PARTOF_ENTITY). The list may only SHRINK. A case the audit stops
 * flagging fails here until it is removed. A new false positive fails as
 * well. Until the list is empty, a 100% audit pass rate on E2 is out of reach
 * even for a perfect agent. P-01 owns the audit, and the worklog records
 * this.
 */
const AUDIT_FALSE_POSITIVES = new Set([
  'classification/pass-non_rooted_resources_that_have_external_classification_references_should_also_pass',
  'entity/fail-in_ifc2x3_a_user_defined_airterminal_predefined_type_resolves_via_the_type_mapping_table_2_2',
  'entity/fail-in_ifc2x3_an_airterminal_can_be_checked_by_name_via_the_type_mapping_table_2_2',
  'entity/fail-in_ifc2x3_an_airterminal_predefined_type_resolves_via_the_type_mapping_table_2_2',
  'entity/fail-in_ifc2x3_there_must_be_an_airterminal_per_the_type_mapping_table_2_2',
  'entity/fail-restrictions_can_be_specified_for_the_predefined_type_3_3',
  'entity/fail-user_defined_types_are_checked_case_sensitively',
  'entity/pass-a_predefined_type_may_specify_a_user_defined_element_type',
  'entity/pass-a_predefined_type_may_specify_a_user_defined_object_type',
  'entity/pass-a_predefined_type_may_specify_a_user_defined_process_type',
  'entity/pass-in_ifc2x3_a_user_defined_airterminal_predefined_type_resolves_via_the_type_mapping_table_1_2',
  'entity/pass-in_ifc2x3_an_airterminal_can_be_checked_by_name_via_the_type_mapping_table_1_2',
  'entity/pass-in_ifc2x3_an_airterminal_predefined_type_resolves_via_the_type_mapping_table_1_2',
  'entity/pass-in_ifc2x3_there_must_be_an_airterminal_per_the_type_mapping_table_1_2',
  'entity/pass-inherited_predefined_types_should_pass',
  'entity/pass-overridden_predefined_types_should_pass',
  'entity/pass-restrictions_can_be_specified_for_the_predefined_type_1_3',
  'entity/pass-restrictions_can_be_specified_for_the_predefined_type_2_3',
]);

test('self-check: the original corpus IDS as candidate agrees on every E2 case', async () => {
  // Validates the dataset (paths, verdicts) and the scorer (IFC loading,
  // verdict rule) together: any mismatch between them shows up here.
  const scores = [];
  for (const record of cases) scores.push(await scorer.scoreCase(corpusIds(record), record));
  const summary = summariseE2(scores);
  assert.deepEqual(summary.disagreements, []);
  assert.equal(summary.cases, 307);
  assert.equal(summary.agreement, 1);
  assert.deepEqual(summary.byExpected, { pass: { cases: 187, agreed: 187 }, fail: { cases: 120, agreed: 120 } });
  assert.equal(summary.unscorable, 0);

  const flagged = scores.filter(score => score.audit.status === 'error').map(score => score.id);
  assert.deepEqual(flagged.filter(id => !AUDIT_FALSE_POSITIVES.has(id)), [], 'new audit false positives on conforming corpus IDS');
  assert.deepEqual([...AUDIT_FALSE_POSITIVES].filter(id => !flagged.includes(id)), [], 'now audits clean: delete from AUDIT_FALSE_POSITIVES');
  assert.equal(summary.audit.valid + summary.audit.warning, 307 - AUDIT_FALSE_POSITIVES.size);
});

test('a candidate that inverts the requirement disagrees on a pass case', async () => {
  const record = byId.get('attribute/pass-attributes_with_a_string_value_should_pass');
  const inverted = corpusIds(record).replace('<attribute>', '<attribute cardinality="prohibited">');
  assert.notEqual(inverted, corpusIds(record), 'fixture assumption: the requirement is a plain <attribute>');
  const score = await scorer.scoreCase(inverted, record);
  assert.equal(score.verdict, 'fail');
  assert.equal(score.agreement, false);
  assert.equal(score.error, null);
});

test('a too-lax candidate disagrees on a fail case', async () => {
  // Same applicability, requirement dropped to "has a Name": the corpus case
  // fails only because the name's capitalisation is wrong.
  const record = byId.get('attribute/fail-attributes_should_check_strings_case_sensitively_2_2');
  const lax = corpusIds(record).replace(/<value>[\s\S]*?<\/value>/, '');
  assert.notEqual(lax, corpusIds(record), 'fixture assumption: the requirement carries a value');
  const score = await scorer.scoreCase(lax, record);
  assert.equal(score.verdict, 'pass');
  assert.equal(score.agreement, false);
});

test('an unparseable candidate is unscorable, never agreeing, and still audited', async () => {
  const record = byId.get('attribute/fail-attributes_with_null_values_always_fail');
  const score = await scorer.scoreCase('<ids><not-closed>', record);
  assert.equal(score.verdict, null);
  assert.equal(score.agreement, false);
  assert.match(score.error, /does not parse|no specifications/);
  assert.equal(score.audit.status, 'error');
});

test('summariseE2 reports null agreement for an empty run rather than a perfect one', () => {
  const summary = summariseE2([]);
  assert.equal(summary.agreement, null);
  assert.equal(summary.cases, 0);
});
