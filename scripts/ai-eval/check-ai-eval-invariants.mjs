#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Gate: release invariants over the recorded corpus (#6928). Every recording in
 * `tests/ai-eval/recordings` is decoded the way the viewer decodes it and run
 * through the deterministic detectors in `lib/invariants.mjs`:
 *
 *   - a `release` recording must produce ZERO violations (the plan tolerates none);
 *   - a `negative` recording must produce exactly the violations it names, so a
 *     detector that stops firing fails here;
 *   - every invariant must be proven to fire by at least one negative recording.
 *
 * These are machine checks. They never say a claim is TRUE; that is the human
 * claim label (`label.mjs`). Usage: node scripts/ai-eval/check-ai-eval-invariants.mjs [--root <repo>]
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INVARIANT_IDS, checkAnswer } from './lib/invariants.mjs';
import { decodeRecording, loadRecordingDir, REPO_ROOT } from './lib/recording.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

/** Violations of one recording as `{ outcome, ids, details }`; an error response has no answer to check. */
export function checkRecording(recording, maxOutputTokens) {
  const decoded = decodeRecording(recording);
  if (decoded.outcome === 'error') return { outcome: 'error', ids: [], details: [] };
  const { violations } = checkAnswer({ text: decoded.text, source: recording.evidence.source, evidence: recording.evidence,
    usage: decoded.usage, maxOutputTokens });
  return { outcome: decoded.outcome, ids: [...new Set(violations.map(violation => violation.id))].sort(), details: violations };
}

export function run(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'tests', 'ai-eval', 'manifest.json'), 'utf8'));
  const ceiling = manifest.liveEvaluation.maxOutputTokens;
  const errors = [];
  const proven = new Set();
  const recordings = loadRecordingDir(join(root, 'tests', 'ai-eval', 'recordings'));
  for (const { name, recording } of recordings) {
    if (recording.corpus === 'live') continue;
    const result = checkRecording(recording, ceiling);
    if (result.outcome !== recording.expect.outcome) errors.push(`${name}: stream decodes to outcome ${result.outcome}, recording expects ${recording.expect.outcome}`);
    const expected = [...recording.expect.violations].sort();
    if (JSON.stringify(result.ids) !== JSON.stringify(expected)) {
      errors.push(`${name}: violations [${result.ids}] differ from the expected [${expected}]${result.details.length ? ` (${result.details.map(detail => detail.detail).join('; ')})` : ''}`);
    }
    if (recording.corpus === 'negative') for (const id of result.ids) proven.add(id);
  }
  for (const id of INVARIANT_IDS) if (!proven.has(id)) errors.push(`invariant ${id}: no negative recording proves its detector fires`);
  return { errors, recordings: recordings.length };
}

if (isMainEntry(import.meta.url)) {
  const at = process.argv.indexOf('--root');
  const { errors, recordings } = run(at >= 0 ? resolve(process.argv[at + 1]) : REPO_ROOT);
  if (errors.length) {
    console.error(`check-ai-eval-invariants: ${errors.length} problem(s)\n${errors.map(error => `  - ${error}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`check-ai-eval-invariants: ${recordings} recording(s); release corpus has no violations and every detector is proven to fire`);
  }
}
