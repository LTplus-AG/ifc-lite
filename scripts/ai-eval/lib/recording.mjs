/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recording files (#6928): load, validate against
 * `tests/ai-eval/recording.schema.json`, and decode into the answer the
 * viewer would have received. The viewer replays the same files through its
 * real Assistant path (`apps/viewer/src/test/ai-eval-replay.ts`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSchema } from './schema-subset.mjs';
import { foldEvents, outcomeOf, parseEvents, sseData } from './sse.mjs';
import { INVARIANT_IDS } from './invariants.mjs';

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
export const RECORDINGS_DIR = join(REPO_ROOT, 'tests', 'ai-eval', 'recordings');
const SCHEMA_PATH = join(REPO_ROOT, 'tests', 'ai-eval', 'recording.schema.json');

let schema;
const recordingSchema = () => (schema ??= JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

/** Structural and semantic errors for one parsed recording. */
export function recordingErrors(recording) {
  const errors = validateSchema(recordingSchema(), recording);
  if (errors.length) return errors;
  const { response, corpus, expect } = recording;
  if ((response.events === undefined) === (response.body === undefined)) errors.push('$.response: needs exactly one of events or body');
  if (response.body !== undefined && response.status === 200) errors.push('$.response.body: a 200 response is recorded as events');
  if (corpus !== 'live' && !expect) errors.push(`$.expect: required for ${corpus} recordings`);
  if (corpus === 'release' && expect?.violations.length) errors.push('$.expect.violations: release recordings tolerate no violations');
  if (corpus === 'negative' && !expect?.violations.length) errors.push('$.expect.violations: a negative recording must name the invariant it proves fires');
  for (const id of expect?.violations ?? []) if (!INVARIANT_IDS.includes(id)) errors.push(`$.expect.violations: unknown invariant ${id}`);
  if (corpus !== 'live' && recording.provenance.kind === 'live' && !recording.provenance.receipt) {
    errors.push('$.provenance.receipt: a promoted live recording keeps its usage receipt');
  }
  return errors;
}

/** Every `*.json` in a directory, parsed, with its file name. */
export function loadRecordingDir(dir) {
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort()
    .map(name => ({ name, recording: JSON.parse(readFileSync(join(dir, name), 'utf8')) }));
}

/** What the viewer would receive: answer text, finish reason, reported usage and typed outcome. */
export function decodeRecording(recording) {
  const events = recording.response.events ?? parseEvents(sseData(recording.response.body ?? ''));
  const folded = foldEvents(recording.route.kind, events);
  return { ...folded, outcome: outcomeOf(recording.response.status, folded) };
}
