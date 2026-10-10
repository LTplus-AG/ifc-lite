/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS Studio E2 dataset (IDS-087): one natural-language task per
 * buildingSMART IDS corpus `pass-`/`fail-` case, stored as JSON Lines in
 * `tests/ai-eval/ids/e2/cases.jsonl`.
 *
 * The corpus files are CC BY-ND 4.0 and are only REFERENCED by path; the
 * descriptions are ours. This module loads the dataset and checks it against
 * the corpus on disk, so a corpus update (or a hand edit to the dataset) that
 * drops, duplicates or mislabels a case fails loudly instead of shrinking the
 * benchmark without anyone noticing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
export const CORPUS_REL = 'packages/ids/src/__corpus__/buildingsmart-ids';
export const E2_CASES_REL = 'tests/ai-eval/ids/e2/cases.jsonl';

const FIELDS = ['id', 'corpusIds', 'corpusIfc', 'expected', 'ifcVersion', 'description', 'language', 'reviewed'];
const IFC_VERSIONS = new Set(['IFC2X3', 'IFC4', 'IFC4X3_ADD2']);

/**
 * Parse a JSON Lines file. Blank lines are ignored; a malformed line throws
 * with its 1-based line number.
 *
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseJsonl(text) {
  const records = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return records;
}

/** @returns {object[]} every E2 case, in file order. */
export function loadE2Cases(root = REPO_ROOT) {
  return parseJsonl(readFileSync(join(root, E2_CASES_REL), 'utf8'));
}

/**
 * The `pass-`/`fail-` cases the corpus holds on disk, keyed by
 * `<facet dir>/<file base name>` (the same id shape `corpus.test.ts` uses).
 *
 * @returns {Map<string, { expected: 'pass' | 'fail', ids: string, ifc: string }>}
 */
export function corpusModelCases(root = REPO_ROOT) {
  const corpus = join(root, CORPUS_REL);
  const cases = new Map();
  for (const dir of readdirSync(corpus).sort()) {
    if (!statSync(join(corpus, dir)).isDirectory()) continue;
    for (const name of readdirSync(join(corpus, dir)).sort()) {
      if (!name.endsWith('.ids')) continue;
      const base = name.slice(0, -4);
      const expected = base.startsWith('pass-') ? 'pass' : base.startsWith('fail-') ? 'fail' : null;
      if (!expected) continue;
      cases.set(`${dir}/${base}`, {
        expected,
        ids: `${CORPUS_REL}/${dir}/${base}.ids`,
        ifc: `${CORPUS_REL}/${dir}/${base}.ifc`,
      });
    }
  }
  return cases;
}

/** The space-separated `ifcVersion` of the corpus file's single specification. */
function corpusIfcVersions(root, idsRel) {
  const match = /<specification\b[^>]*\bifcVersion="([^"]+)"/.exec(readFileSync(join(root, idsRel), 'utf8'));
  return match ? match[1].trim().split(/\s+/) : [];
}

/**
 * Every problem with the dataset, as readable strings; empty means it is
 * consistent with the corpus on disk.
 *
 * @param {object[]} cases
 * @param {string} [root]
 * @returns {string[]}
 */
export function e2DatasetErrors(cases, root = REPO_ROOT) {
  const errors = [];
  const corpus = corpusModelCases(root);
  if (corpus.size === 0) errors.push(`no pass-/fail- cases found under ${CORPUS_REL}; an empty corpus must not validate`);
  const seen = new Set();
  cases.forEach((record, index) => {
    const at = `case ${index + 1}${record && typeof record.id === 'string' ? ` (${record.id})` : ''}`;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push(`${at}: not an object`);
      return;
    }
    const keys = Object.keys(record);
    for (const field of FIELDS) if (!keys.includes(field)) errors.push(`${at}: missing ${field}`);
    for (const key of keys) if (!FIELDS.includes(key)) errors.push(`${at}: unknown field ${key}`);
    if (seen.has(record.id)) errors.push(`${at}: duplicate id`);
    seen.add(record.id);
    const source = corpus.get(record.id);
    if (!source) {
      errors.push(`${at}: no corpus pass-/fail- case has this id`);
      return;
    }
    if (record.corpusIds !== source.ids) errors.push(`${at}: corpusIds should be ${source.ids}`);
    if (record.corpusIfc !== source.ifc) errors.push(`${at}: corpusIfc should be ${source.ifc}`);
    if (!existsSync(join(root, source.ifc))) errors.push(`${at}: paired IFC ${source.ifc} is missing`);
    if (record.expected !== source.expected) errors.push(`${at}: expected should be ${source.expected} (from the file prefix)`);
    const versions = corpusIfcVersions(root, source.ids);
    if (!Array.isArray(record.ifcVersion) || record.ifcVersion.join(' ') !== versions.join(' ')) {
      errors.push(`${at}: ifcVersion should be ${JSON.stringify(versions)}`);
    }
    for (const version of Array.isArray(record.ifcVersion) ? record.ifcVersion : []) {
      if (!IFC_VERSIONS.has(version)) errors.push(`${at}: unknown IFC version ${version}`);
    }
    if (typeof record.description !== 'string' || record.description.trim().length < 20) {
      errors.push(`${at}: description must be a sentence of at least 20 characters`);
    } else if (/<\/?[a-z][\w:-]*[\s>]|xs:restriction|simpleValue/i.test(record.description)) {
      errors.push(`${at}: description contains IDS/XML markup; describe the requirement in words`);
    }
    if (record.language !== 'en') errors.push(`${at}: language must be 'en' (other languages belong to E3)`);
    if (typeof record.reviewed !== 'boolean') errors.push(`${at}: reviewed must be a boolean`);
  });
  for (const id of corpus.keys()) if (!seen.has(id)) errors.push(`corpus case ${id} has no E2 record`);
  return errors;
}
