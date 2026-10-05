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
 * sheets and the U01 study protocol and session records. Stated gaps (unfetched
 * fixtures, journeys without tasks, pending human review) are printed as
 * notes, never hidden.
 *
 * Usage: node scripts/ai-eval/check-ai-eval-manifest.mjs [--root <repo>]
 * Wired: node-tests job in .github/workflows/test.yml.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkManifest } from './lib/manifest.mjs';
import { loadRecordingDir, REPO_ROOT } from './lib/recording.mjs';
import { loadLabelDir, sheetFileErrors } from './label.mjs';
import { loadStudy } from './study.mjs';
import { protocolErrors, sessionErrors } from './lib/study.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

export function run(root) {
  const manifestPath = join(root, 'tests', 'ai-eval', 'manifest.json');
  if (!existsSync(manifestPath)) return { errors: [`${manifestPath} does not exist`], notes: [] };
  const recordingsDir = join(root, 'tests', 'ai-eval', 'recordings');
  const recordings = existsSync(recordingsDir) ? loadRecordingDir(recordingsDir) : [];
  const result = checkManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), { root, recordings });
  if (!recordings.length) result.errors.push('tests/ai-eval/recordings holds no recordings; the replay harness would pass vacuously');
  const labels = loadLabelDir(root);
  result.errors.push(...sheetFileErrors(labels, recordings, JSON.parse(readFileSync(join(root, 'tests', 'ai-eval', 'label-sheet.schema.json'), 'utf8'))));
  const study = loadStudy(root);
  result.errors.push(...protocolErrors(study.protocol, { root, manifest: study.manifest }), ...sessionErrors(study.sessions, study.protocol, study.schema));
  result.notes.push(`${labels.length} label sheet(s) and ${study.sessions.length} study session(s) committed; human labelling and the coordinator study stay open until people perform them`);
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
