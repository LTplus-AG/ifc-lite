#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Gate: the AI evaluation manifest and its recordings are well-formed and
 * truthful (#6928). Validates `tests/ai-eval/manifest.json` against its
 * schema, recomputes every committed fixture fingerprint, cross-checks
 * fixture-mechanism entries against `tests/models/manifest.json`, runs the
 * automated privacy scan, and ties every recording in
 * `tests/ai-eval/recordings` to a task and scene, validates committed label
 * sheets, committed live runs and the U01 study protocol and session records. Stated gaps (unfetched
 * fixtures, journeys without tasks, pending human review) are printed as
 * notes, never hidden.
 *
 * Usage: node scripts/ai-eval/check-ai-eval-manifest.mjs [--root <repo>]
 * Wired: node-tests job in .github/workflows/test.yml.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { checkManifest, privacyFindings } from './lib/manifest.mjs';
import { liveRecordings, loadLiveRuns, loadRecordingDir, REPO_ROOT } from './lib/recording.mjs';
import { loadLabelDir, sheetFileErrors } from './label.mjs';
import { loadStudy } from './study.mjs';
import { protocolErrors, sessionErrors } from './lib/study.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

/** Order-insensitive equality of two lists of JSON values. */
const sameItems = (a, b) => JSON.stringify(a.map(item => JSON.stringify(item)).sort()) === JSON.stringify(b.map(item => JSON.stringify(item)).sort());

/**
 * A committed live run must be exactly what the runner and the native review
 * produced: live recordings with their receipts, the run summary holding the
 * same receipts, a review of every recording, and nothing a privacy scan flags.
 */
function liveRunErrors({ run, dir, recordings }) {
  const at = `live run ${run}`;
  const errors = [];
  if (!recordings.length) errors.push(`${at}: holds no recordings`);
  for (const { name, recording } of recordings) {
    if (recording.corpus !== 'live' || recording.provenance?.kind !== 'live' || !recording.provenance.receipt) {
      errors.push(`${at}: ${name} must stay an unpromoted live recording with its receipt (promote a copy with a new id into tests/ai-eval/recordings)`);
    }
    // Reviews name files and labels name ids: both must point at the same answer, from this run.
    if (name !== `${recording.id}.json`) errors.push(`${at}: ${name} holds recording ${recording.id}`);
    if (!String(recording.id).startsWith(`live-${run}-`)) errors.push(`${at}: ${name} was not recorded by run ${run}`);
  }
  const read = file => (existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : null);
  const summary = read('summary.json');
  if (!summary) errors.push(`${at}: summary.json is missing`);
  else {
    if (summary.runId !== run) errors.push(`${at}: summary.json is for run ${summary.runId}; name the folder after its runId`);
    // Every request spends budget: a dropped recording or an edited receipt is a different run.
    if (!sameItems(recordings.map(({ recording }) => recording.provenance?.receipt), summary.receipts ?? [])) errors.push(`${at}: recordings and summary.json receipts differ`);
  }
  const review = read('review.json');
  if (!review) errors.push(`${at}: review.json is missing (pnpm ai-eval review)`);
  else {
    if (!sameItems((review.reviews ?? []).map(entry => entry.recording), recordings.map(({ name }) => name))) errors.push(`${at}: review.json does not cover exactly the recordings`);
  }
  // Every committed file, not only the ones the runner writes: notes are free text too.
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)));
  for (const file of files) {
    const findings = privacyFindings(readFileSync(join(dir, file), 'utf8'), 'json');
    if (findings.length) errors.push(`${at}: ${file}: privacy scan: ${findings.join('; ')}`);
  }
  return errors;
}

export function run(root) {
  const manifestPath = join(root, 'tests', 'ai-eval', 'manifest.json');
  if (!existsSync(manifestPath)) return { errors: [`${manifestPath} does not exist`], notes: [] };
  const recordingsDir = join(root, 'tests', 'ai-eval', 'recordings');
  const recordings = existsSync(recordingsDir) ? loadRecordingDir(recordingsDir) : [];
  const liveDir = join(root, 'tests', 'ai-eval', 'live-runs');
  const liveEntries = existsSync(liveDir) ? readdirSync(liveDir, { recursive: true, withFileTypes: true }) : [];
  // A committed symlink would make the gate read, and quote in its errors, a file outside the run: refuse before loading anything.
  const links = liveEntries.filter(entry => entry.isSymbolicLink()).map(entry => `live-runs/${relative(liveDir, join(entry.parentPath, entry.name))}: symlinks are not allowed in live runs`);
  const liveRuns = links.length ? [] : loadLiveRuns(root);
  const live = liveRecordings(liveRuns);
  const result = checkManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), { root, recordings: [...recordings, ...live] });
  result.errors.push(...links);
  for (const liveRun of liveRuns) result.errors.push(...liveRunErrors(liveRun));
  for (const entry of liveEntries) if (entry.parentPath === liveDir && !entry.isDirectory() && !entry.isSymbolicLink()) result.errors.push(`live-runs/${entry.name}: only run folders belong here`);
  if (!recordings.length) result.errors.push('tests/ai-eval/recordings holds no recordings; the replay harness would pass vacuously');
  const required = ['label-sheet.schema.json', 'study/protocol.json', 'study/protocol.schema.json', 'study/session.schema.json'];
  const missing = required.filter(path => !existsSync(join(root, 'tests', 'ai-eval', path)));
  if (missing.length) {
    result.errors.push(...missing.map(path => `tests/ai-eval/${path} does not exist`));
  } else {
    const labels = loadLabelDir(root);
    result.errors.push(...sheetFileErrors(labels, [...recordings, ...live], JSON.parse(readFileSync(join(root, 'tests', 'ai-eval', 'label-sheet.schema.json'), 'utf8'))));
    const study = loadStudy(root);
    result.errors.push(...protocolErrors(study.protocol, { root, manifest: study.manifest }), ...sessionErrors(study.sessions, study.protocol, study.schema));
    result.notes.push(`${liveRuns.length} committed live run(s) with ${live.length} unpromoted recording(s)`);
    result.notes.push(`${labels.length} label sheet(s) and ${study.sessions.length} study session(s) committed; human labelling and the coordinator study stay open until people perform them`);
  }
  return { ...result, recordings: recordings.length };
}

if (isMainEntry(import.meta.url)) {
  const at = process.argv.indexOf('--root');
  const root = at >= 0 ? resolve(process.argv[at + 1]) : REPO_ROOT;
  const { errors, notes, recordings } = run(root);
  for (const note of notes) console.log(`note: ${note}`);
  if (errors.length) {
    console.error(`check-ai-eval-manifest: ${errors.length} problem(s)\n${errors.map(error => `  - ${error}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`check-ai-eval-manifest: manifest and ${recordings} recording(s) OK`);
  }
}
