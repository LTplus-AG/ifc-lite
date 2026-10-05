/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two file shapes of the perf ratchet (#6959), and nothing else: parsing,
 * validation and serialisation. Comparison lives in `compare.mjs`, lowering in
 * `lower.mjs`.
 *
 * CEILING FILE, committed at `tests/perf-ratchets/<family>.json`:
 *
 *   {
 *     "family": "bundle",
 *     "description": "what this family measures and how",
 *     "entries": [
 *       {
 *         "id": "engine-wasm-brotli",        // unique within the family
 *         "metric": "brotli-bytes",          // what kind of number it is
 *         "unit": "bytes",                   // optional, for the report
 *         "fixture": "tests/models/x.ifc",   // optional: the input measured
 *         "description": "...",              // optional
 *         "ceiling": 1300000,                // the committed maximum
 *         "tolerance": { "kind": "relative", "value": 0.005 },
 *         "provenance": { "commit": "<sha>", "measuredAt": "<ISO-8601>" }
 *       }
 *     ]
 *   }
 *
 * Tolerance kinds: `exact` (value must be 0; any rise fails) for structural
 * counts, `relative` (a fraction, 0 < value < 1) for sizes and instruction
 * counts. The tolerance is the WHOLE slack above the ceiling, not a per-PR
 * allowance: the ceiling does not move when a PR lands inside it, so a run of
 * small rises still fails once their sum crosses the band.
 *
 * MEASURED FILE, written by a family's `measure-<family>.mjs`:
 *
 *   {
 *     "family": "bundle",
 *     "commit": "<sha the measurement was taken at>",
 *     "measuredAt": "<ISO-8601>",
 *     "metrics": [ { "id": "engine-wasm-brotli", "value": 1290000, "detail": "..." } ]
 *   }
 *
 * Validation fails closed: a file that parses to no entries, a duplicate id or
 * a non-finite value is an error, never an empty (and therefore passing) check.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const TOLERANCE_KINDS = ['exact', 'relative'];
const FAMILY_RE = /^[a-z][a-z0-9-]*$/;
const ID_RE = /^[a-z0-9][a-z0-9._/-]*$/;

/** Path of a family's committed ceiling file under `ceilingsDir`. */
export function ceilingPath(ceilingsDir, family) {
  if (!FAMILY_RE.test(family)) throw new Error(`invalid perf-ratchet family name ${JSON.stringify(family)}`);
  return join(ceilingsDir, `${family}.json`);
}

function isNonNegativeFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Validate a parsed ceiling file. Returns a list of problems; empty means valid.
 *
 * @param {unknown} data
 * @returns {string[]}
 */
export function validateCeilingFile(data) {
  const problems = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['ceiling file is not a JSON object'];
  if (typeof data.family !== 'string' || !FAMILY_RE.test(data.family)) problems.push('`family` must be a lowercase kebab-case string');
  if (!Array.isArray(data.entries) || data.entries.length === 0) {
    problems.push('`entries` must be a non-empty array (a family with no ceilings checks nothing)');
    return problems;
  }
  const seen = new Set();
  data.entries.forEach((e, i) => {
    const at = `entries[${i}]${e && typeof e.id === 'string' ? ` (${e.id})` : ''}`;
    if (!e || typeof e !== 'object') { problems.push(`${at}: not an object`); return; }
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) problems.push(`${at}: \`id\` must match ${ID_RE}`);
    else if (seen.has(e.id)) problems.push(`${at}: duplicate id`);
    else seen.add(e.id);
    if (typeof e.metric !== 'string' || e.metric === '') problems.push(`${at}: \`metric\` must be a non-empty string`);
    if (e.fixture !== undefined && (typeof e.fixture !== 'string' || e.fixture === '')) problems.push(`${at}: \`fixture\`, when present, must be a non-empty string`);
    if (!isNonNegativeFinite(e.ceiling)) problems.push(`${at}: \`ceiling\` must be a finite number >= 0`);
    const t = e.tolerance;
    if (!t || typeof t !== 'object' || !TOLERANCE_KINDS.includes(t.kind)) {
      problems.push(`${at}: \`tolerance.kind\` must be one of ${TOLERANCE_KINDS.join(', ')}`);
    } else if (t.kind === 'exact' && t.value !== 0) {
      problems.push(`${at}: an \`exact\` tolerance has \`value: 0\``);
    } else if (t.kind === 'relative' && !(typeof t.value === 'number' && t.value > 0 && t.value < 1)) {
      problems.push(`${at}: a \`relative\` tolerance is a fraction, 0 < value < 1 (0.005 = 0.5%)`);
    }
    const p = e.provenance;
    if (!p || typeof p !== 'object' || typeof p.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(p.commit)) {
      problems.push(`${at}: \`provenance.commit\` must be the git sha the ceiling was measured at`);
    }
    if (!p || typeof p.measuredAt !== 'string' || Number.isNaN(Date.parse(p.measuredAt))) {
      problems.push(`${at}: \`provenance.measuredAt\` must be an ISO-8601 timestamp`);
    }
  });
  return problems;
}

/**
 * Validate a parsed measured file. Returns a list of problems; empty means valid.
 *
 * @param {unknown} data
 * @returns {string[]}
 */
export function validateMeasuredFile(data) {
  const problems = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['measured file is not a JSON object'];
  if (typeof data.family !== 'string' || !FAMILY_RE.test(data.family)) problems.push('`family` must be a lowercase kebab-case string');
  if (typeof data.commit !== 'string' || data.commit === '') problems.push('`commit` must name the measured commit');
  if (typeof data.measuredAt !== 'string' || Number.isNaN(Date.parse(data.measuredAt))) problems.push('`measuredAt` must be an ISO-8601 timestamp');
  if (!Array.isArray(data.metrics) || data.metrics.length === 0) {
    problems.push('`metrics` must be a non-empty array (a measurement of nothing is not a pass)');
    return problems;
  }
  const seen = new Set();
  data.metrics.forEach((m, i) => {
    const at = `metrics[${i}]${m && typeof m.id === 'string' ? ` (${m.id})` : ''}`;
    if (!m || typeof m !== 'object') { problems.push(`${at}: not an object`); return; }
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) problems.push(`${at}: \`id\` must match ${ID_RE}`);
    else if (seen.has(m.id)) problems.push(`${at}: duplicate id`);
    else seen.add(m.id);
    if (!isNonNegativeFinite(m.value)) problems.push(`${at}: \`value\` must be a finite number >= 0`);
  });
  return problems;
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${what} ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${what} ${path} is not valid JSON: ${err.message}`);
  }
}

/** Read and validate a ceiling file; throws with every problem listed. */
export function loadCeilingFile(path) {
  if (!existsSync(path)) throw new Error(`no ceiling file at ${path}`);
  const data = readJson(path, 'ceiling file');
  const problems = validateCeilingFile(data);
  if (problems.length) throw new Error(`invalid ceiling file ${path}:\n  - ${problems.join('\n  - ')}`);
  return data;
}

/** Read and validate a measured file; throws with every problem listed. */
export function loadMeasuredFile(path) {
  const data = readJson(path, 'measured file');
  const problems = validateMeasuredFile(data);
  if (problems.length) throw new Error(`invalid measured file ${path}:\n  - ${problems.join('\n  - ')}`);
  return data;
}

/** Stable serialisation: two-space JSON plus a trailing newline. */
export function serializeCeilingFile(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}
