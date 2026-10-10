/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS Studio E4 (edit tasks) and E5 (adversarial) seed sets (IDS-089).
 *
 * E4 is in `tests/ai-eval/ids/e4/cases.jsonl`. Each case has an input IDS, an
 * instruction, and the IDS expected after the edit; the IDS files are in
 * `e4/ids/`. E5 is in `tests/ai-eval/ids/e5/cases.jsonl`. Each case is a
 * request or document text with the behaviour we expect: `reject` an invented
 * name, mark the statement `unresolved` with a category, or `ignore-injection`
 * while still authoring the legitimate requirements.
 *
 * All of it is self-authored. These checks keep it honest: every IDS parses
 * and audits clean, every edit changes the document, and every name an E5
 * case calls invented really is missing from the IFC schema tables.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonl, REPO_ROOT } from './e2-dataset.mjs';

export const E4_DIR_REL = 'tests/ai-eval/ids/e4';
export const E5_DIR_REL = 'tests/ai-eval/ids/e5';

export const E4_CHANGE_KINDS = new Set([
  'add-requirement', 'remove-requirement', 'add-specification', 'remove-specification', 'rename-specification',
  'restrict-value', 'change-value', 'change-cardinality', 'change-specification-optionality', 'change-ifc-version',
  'narrow-applicability', 'widen-applicability', 'edit-metadata',
]);
const E4_FIELDS = ['id', 'input', 'instruction', 'expected', 'changes', 'language', 'reviewed'];

/** E5 category → the only behaviour that category allows. */
export const E5_BEHAVIOUR = { 'unknown-name': 'reject', 'out-of-scope': 'unresolved', 'prompt-injection': 'ignore-injection' };
/** The statement classes of the agent method (06-ai-agent.md §6) that are not IDS. */
export const UNRESOLVED_CATEGORIES = new Set(['geometry', 'rules-engine', 'manual', 'ambiguous']);
const E5_FIELDS = ['id', 'category', 'input', 'expected', 'rationale', 'language', 'reviewed'];
const E5_INPUT_KINDS = new Set(['request', 'document', 'ifc-string']);
const SCHEMA_VERSIONS = ['IFC2X3', 'IFC4', 'IFC4X3_ADD2'];

export const loadE4Cases = (root = REPO_ROOT) => parseJsonl(readFileSync(join(root, E4_DIR_REL, 'cases.jsonl'), 'utf8'));
export const loadE5Cases = (root = REPO_ROOT) => parseJsonl(readFileSync(join(root, E5_DIR_REL, 'cases.jsonl'), 'utf8'));

function fieldErrors(record, fields, at) {
  const errors = [];
  const keys = Object.keys(record);
  for (const field of fields) if (!keys.includes(field)) errors.push(`${at}: missing ${field}`);
  for (const key of keys) if (!fields.includes(key)) errors.push(`${at}: unknown field ${key}`);
  if (record.language !== 'en') errors.push(`${at}: language must be 'en'`);
  if (typeof record.reviewed !== 'boolean') errors.push(`${at}: reviewed must be a boolean`);
  return errors;
}

const label = (record, index) => `case ${index + 1}${typeof record?.id === 'string' ? ` (${record.id})` : ''}`;

/**
 * Structural problems with the E4 set, plus parse/audit/no-op problems for
 * each IDS pair. `ids` is `loadIdsToolchain()`'s result.
 *
 * @returns {Promise<string[]>}
 */
export async function e4DatasetErrors(cases, ids, root = REPO_ROOT) {
  const errors = [];
  const dir = join(root, E4_DIR_REL);
  const seen = new Set();
  const referenced = new Set();
  const expectedUse = new Map();
  for (const [index, record] of cases.entries()) {
    const at = label(record, index);
    errors.push(...fieldErrors(record, E4_FIELDS, at));
    if (seen.has(record.id)) errors.push(`${at}: duplicate id`);
    seen.add(record.id);
    if (typeof record.instruction !== 'string' || record.instruction.trim().length < 10) errors.push(`${at}: instruction is too short`);
    if (!Array.isArray(record.changes) || record.changes.length === 0) errors.push(`${at}: changes must name at least one kind`);
    for (const kind of Array.isArray(record.changes) ? record.changes : []) {
      if (!E4_CHANGE_KINDS.has(kind)) errors.push(`${at}: unknown change kind ${kind}`);
    }
    expectedUse.set(record.expected, (expectedUse.get(record.expected) ?? 0) + 1);
    const texts = {};
    for (const key of ['input', 'expected']) {
      const path = join(dir, String(record[key]));
      referenced.add(record[key]);
      if (!existsSync(path)) {
        errors.push(`${at}: ${key} file ${record[key]} does not exist`);
        continue;
      }
      texts[key] = readFileSync(path, 'utf8');
    }
    if (texts.input === undefined || texts.expected === undefined) continue;
    const parsed = {};
    for (const key of ['input', 'expected']) {
      try {
        parsed[key] = ids.parseIDS(texts[key]);
      } catch (error) {
        errors.push(`${at}: ${key} does not parse: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const audit = await ids.auditIDSDocument(texts[key]);
      if (audit.issues.length) errors.push(`${at}: ${key} audit ${audit.status}: ${audit.issues.map(issue => issue.code).join(', ')}`);
    }
    if (parsed.input && parsed.expected && JSON.stringify(parsed.input) === JSON.stringify(parsed.expected)) {
      errors.push(`${at}: the expected IDS parses to the same document as the input; the edit changes nothing`);
    }
  }
  for (const [path, count] of expectedUse) if (count > 1) errors.push(`expected file ${path} is shared by ${count} cases`);
  const idsDir = join(dir, 'ids');
  const onDisk = existsSync(idsDir) ? readdirSync(idsDir).filter(name => name.endsWith('.ids')).map(name => `ids/${name}`) : [];
  for (const path of onDisk) if (!referenced.has(path)) errors.push(`${E4_DIR_REL}/${path} is not used by any case`);
  return errors;
}

/**
 * Is `name` known to the IFC schema tables in any supported version? Pset_
 * names are looked up as property sets, IFC* names as entities, and anything
 * else as a property name in some standard property set.
 */
export async function knownToSchema(schema, name) {
  for (const version of SCHEMA_VERSIONS) {
    if (/^Pset_/i.test(name)) {
      if (await schema.findPropertySet(version, name)) return true;
    } else if (/^IFC/i.test(name)) {
      if (await schema.findEntity(version, name)) return true;
    } else {
      const psets = await schema.getPropertySets(version);
      if (psets.some(pset => pset.properties.some(property => property.name === name))) return true;
    }
  }
  return false;
}

/**
 * Structural problems with the E5 set, plus the schema oracle: every name an
 * `unknown-name` case says the agent must not emit is checked against the IFC
 * schema tables, so a case cannot call a real name invented. `schema` is
 * `loadSchemaData()`'s result.
 *
 * @returns {Promise<string[]>}
 */
export async function e5DatasetErrors(cases, schema) {
  const errors = [];
  const seen = new Set();
  for (const [index, record] of cases.entries()) {
    const at = label(record, index);
    errors.push(...fieldErrors(record, E5_FIELDS, at));
    if (seen.has(record.id)) errors.push(`${at}: duplicate id`);
    seen.add(record.id);
    const behaviour = E5_BEHAVIOUR[record.category];
    if (!behaviour) {
      errors.push(`${at}: unknown category ${record.category}`);
      continue;
    }
    const { input, expected } = record;
    if (!input || !E5_INPUT_KINDS.has(input.kind) || typeof input.text !== 'string' || !input.text.trim()) {
      errors.push(`${at}: input needs a kind (${[...E5_INPUT_KINDS].join('/')}) and non-empty text`);
    }
    if (!expected || expected.behaviour !== behaviour) {
      errors.push(`${at}: a ${record.category} case expects behaviour ${behaviour}`);
      continue;
    }
    if (!Array.isArray(expected.mustNotEmit) || !Array.isArray(expected.mustCover)) {
      errors.push(`${at}: expected.mustNotEmit and expected.mustCover must be arrays`);
      continue;
    }
    const needsCategory = behaviour !== 'ignore-injection';
    if (needsCategory ? !UNRESOLVED_CATEGORIES.has(expected.unresolvedCategory) : expected.unresolvedCategory !== null) {
      errors.push(`${at}: unresolvedCategory must be ${needsCategory ? `one of ${[...UNRESOLVED_CATEGORIES].join('/')}` : 'null'}`);
    }
    if (record.category === 'unknown-name') {
      if (expected.mustNotEmit.length === 0) errors.push(`${at}: an unknown-name case must name what must not be emitted`);
      for (const name of expected.mustNotEmit) {
        if (!input.text.toUpperCase().includes(name.toUpperCase())) errors.push(`${at}: ${name} does not appear in the request`);
        if (await knownToSchema(schema, name)) errors.push(`${at}: ${name} exists in the IFC schema tables, so it is not invented`);
      }
    }
    if (typeof record.rationale !== 'string' || record.rationale.trim().length < 20) errors.push(`${at}: rationale is too short`);
  }
  return errors;
}

