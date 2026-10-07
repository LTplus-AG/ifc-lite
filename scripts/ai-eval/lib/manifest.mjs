/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The AI evaluation manifest (#6928): `tests/ai-eval/manifest.json`, its
 * schema, and the semantic checks a schema cannot express — fingerprints
 * recomputed from the bytes, fixture-mechanism entries cross-checked against
 * `tests/models/manifest.json`, native results pinned to the model they came
 * from, an automated privacy scan, and every recording tied to a task.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSchema } from './schema-subset.mjs';
import { INVARIANT_IDS } from './invariants.mjs';
import { recordingErrors } from './recording.mjs';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const CREDENTIAL = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abpr]-[A-Za-z0-9-]{10,})\b/;
const STEP_FILE_NAME = /FILE_NAME\(\s*'(?:[^']|'')*'\s*,\s*'(?:[^']|'')*'\s*,\s*(\([^)]*\)|\$)\s*,\s*(\([^)]*\)|\$)/;
const hasText = list => /'(?:[^']|'')+'/.test(list);

/**
 * Automated privacy findings for one file's text; empty means the scan passed.
 * `allowance` is a fixture's reviewed `privacy.stepHeaderAllowance`: it excuses
 * ONLY an author/organisation pair that equals its recorded values exactly, so
 * any other header text (or an e-mail or credential anywhere) still fails.
 */
export function privacyFindings(text, kind, allowance = null) {
  const findings = [];
  if (EMAIL.test(text)) findings.push(`e-mail address ${EMAIL.exec(text)[0]}`);
  if (CREDENTIAL.test(text)) findings.push('credential-like token');
  if (kind === 'ifc') {
    const header = STEP_FILE_NAME.exec(text.slice(0, 20_000));
    if (!header) findings.push('no parseable STEP FILE_NAME header');
    else if (allowance && header[1] === allowance.author && header[2] === allowance.organisation) { /* reviewed, exact header values */ }
    else if (hasText(header[1]) || hasText(header[2])) findings.push(`STEP author/organisation present: ${header[1]} ${header[2]}`);
  }
  return findings;
}

/**
 * Errors (gate failures) and notes (stated gaps) for a manifest under `root`.
 * `recordings` is `[{ name, recording }]`.
 */
export function checkManifest(manifest, { root, recordings = [] }) {
  const errors = [];
  const notes = [];
  const schema = readJson(join(root, 'tests', 'ai-eval', 'manifest.schema.json'));
  const structural = validateSchema(schema, manifest);
  if (structural.length) return { errors: structural, notes };

  for (const group of ['journeys', 'scenes', 'fixtures', 'tasks']) {
    const seen = new Set();
    for (const { id } of manifest[group]) {
      if (seen.has(id)) errors.push(`${group}: duplicate id ${id}`);
      seen.add(id);
    }
  }
  const fixtures = new Map(manifest.fixtures.map(fixture => [fixture.id, fixture]));
  const scenes = new Map(manifest.scenes.map(scene => [scene.id, scene]));
  const journeys = new Set(manifest.journeys.map(journey => journey.id));
  const catalogue = readJson(join(root, 'tests', 'models', 'manifest.json'));
  const catalogued = new Map(catalogue.files.map(file => [`tests/models/${file.path}`, file]));

  for (const fixture of manifest.fixtures) {
    const at = `fixture ${fixture.id}`;
    const path = join(root, fixture.path);
    if (fixture.origin === 'fixtures') {
      const entry = catalogued.get(fixture.path);
      if (!entry) errors.push(`${at}: ${fixture.path} is not catalogued in tests/models/manifest.json`);
      else if (entry.sha256 !== fixture.sha256 || entry.size !== fixture.size) errors.push(`${at}: fingerprint differs from tests/models/manifest.json`);
      if (fixture.privacy.automated !== 'not-fetched') errors.push(`${at}: fetched fixtures declare automated privacy "not-fetched"; the gate scans them when present`);
      if (!existsSync(path)) { notes.push(`${at}: not fetched (run pnpm fixtures); fingerprint checked against the catalogue only`); continue; }
    } else if (!existsSync(path)) {
      errors.push(`${at}: committed file ${fixture.path} is missing`);
      continue;
    } else if (fixture.privacy.automated !== 'pass') {
      errors.push(`${at}: a committed fixture must pass the automated privacy scan`);
    }
    const bytes = readFileSync(path);
    if (sha256(bytes) !== fixture.sha256 || bytes.length !== fixture.size) {
      errors.push(`${at}: ${fixture.path} is ${bytes.length} bytes with sha256 ${sha256(bytes)}; the manifest records ${fixture.size} / ${fixture.sha256}`);
    }
    const findings = privacyFindings(bytes.toString('latin1'), fixture.kind, fixture.privacy.stepHeaderAllowance);
    if (findings.length) errors.push(`${at}: privacy scan: ${findings.join('; ')}`);
    if (fixture.source.derivedFrom && !fixtures.has(fixture.source.derivedFrom)) errors.push(`${at}: derivedFrom ${fixture.source.derivedFrom} is not a fixture`);
    if (fixture.kind === 'native-result') {
      const parent = fixtures.get(fixture.source.derivedFrom ?? '');
      const provenance = JSON.parse(bytes.toString('utf8')).provenance;
      if (!parent || provenance?.sha256 !== parent.sha256 || provenance?.model !== parent.path) {
        errors.push(`${at}: native result provenance must name its derivedFrom model path and sha256`);
      }
    }
  }
  for (const scene of manifest.scenes) {
    for (const id of scene.fixtures) if (!fixtures.has(id)) errors.push(`scene ${scene.id}: unknown fixture ${id}`);
  }
  for (const task of manifest.tasks) {
    const at = `task ${task.id}`;
    if (!journeys.has(task.journey)) errors.push(`${at}: unknown journey ${task.journey}`);
    if (!scenes.has(task.scene)) errors.push(`${at}: unknown scene ${task.scene}`);
    for (const id of task.invariants) if (!INVARIANT_IDS.includes(id)) errors.push(`${at}: unknown invariant ${id}`);
    const grouping = task.labels.some(label => label === 'grouping' || label === 'classification');
    if (grouping && task.expectedOutput !== 'clash.groups') errors.push(`${at}: grouping/classification labels need a clash.groups task`);
    if (task.labels.includes('claims') && task.expectedOutput !== 'prose') errors.push(`${at}: claim labels need a prose task`);
  }
  const tasks = new Map(manifest.tasks.map(task => [task.id, task]));
  for (const { name, recording } of recordings) {
    for (const error of recordingErrors(recording)) errors.push(`recording ${name}: ${error}`);
    const task = tasks.get(recording.task);
    if (!task) { errors.push(`recording ${name}: unknown task ${recording.task}`); continue; }
    if (recording.scene !== task.scene) errors.push(`recording ${name}: scene ${recording.scene} differs from task scene ${task.scene}`);
    if (recording.evidence?.source !== scenes.get(task.scene)?.source) errors.push(`recording ${name}: evidence source differs from the scene source`);
  }
  const covered = new Set(manifest.tasks.map(task => task.journey));
  const uncovered = manifest.journeys.filter(journey => !covered.has(journey.id)).map(journey => journey.id);
  if (uncovered.length) notes.push(`journeys without evaluation tasks yet: ${uncovered.join(', ')}`);
  const pendingReview = manifest.fixtures.filter(fixture => fixture.privacy.human.status !== 'complete').length;
  if (pendingReview) notes.push(`${pendingReview} fixture(s) await human privacy review`);
  return { errors, notes };
}
