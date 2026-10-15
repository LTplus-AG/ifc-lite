/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer half of the live AI evaluation (#6928), driven by
 * `scripts/ai-eval/run-live-eval.mjs` (never by CI, never with credentials):
 *
 *   requests --manifest <eval manifest> --model <id> --out <file> [--tasks a,b]
 *     Seeds each task's real-model scene and captures the exact request the
 *     Assistant would send (system prompt with frozen evidence, messages,
 *     output ceiling) through a fetch stub. No network.
 *   review --recordings <dir> --out <file>
 *     Replays live recordings through the real Assistant path and records the
 *     native review (typed proposal preview or report-draft citation checks).
 *   refresh --recordings <dir>
 *     Rewrites each recording's frozen `evidence` from its freshly seeded scene
 *     (after a model, fixture or adapter change). Review the diff.
 *
 * Run from apps/viewer: `pnpm ai-eval <command> ...` (see package.json).
 */

import '../src/test/setup-dom.js';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { comparableEvidence, seedScene } from '../src/test/ai-eval-scenes.js';
import { captureRequest, type CaptureTask } from '../src/test/ai-eval-capture.js';
import { replayRecording, type Recording } from '../src/test/ai-eval-replay.js';
import { reviewReplay } from '../src/test/ai-eval-review.js';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const at = rest.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = rest[at + 1];
  // A missing operand, or the next flag in its place, is an error rather than a value.
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
};
const required = (name: string) => {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required`);
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
};

async function captureRequests(): Promise<void> {
  const manifest = JSON.parse(readFileSync(required('manifest'), 'utf8')) as { tasks: CaptureTask[] };
  const model = flag('model');
  if (!model) throw new Error('--model is required (the live model id, so output ceilings match)');
  const only = flag('tasks')?.split(',');
  const out: unknown[] = [];
  for (const task of manifest.tasks.filter(item => !only || only.includes(item.id))) out.push(await captureRequest(task, model));
  writeFileSync(required('out'), `${JSON.stringify({ version: 1, model, tasks: out }, null, 2)}\n`);
}

async function reviewRecordings(): Promise<void> {
  const dir = required('recordings');
  const reviews: unknown[] = [];
  for (const name of readdirSync(dir).filter(file => file.endsWith('.json')).sort()) {
    const recording = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Recording;
    const replay = await replayRecording(recording);
    if ('missing' in replay) { reviews.push({ recording: name, skipped: replay.missing }); continue; }
    reviews.push({ recording: name, task: recording.task, completed: replay.completed, error: replay.error,
      proposal: replay.proposal, review: reviewReplay(replay) });
  }
  writeFileSync(required('out'), `${JSON.stringify({ version: 1, reviews }, null, 2)}\n`);
}

async function refreshEvidence(): Promise<void> {
  const dir = required('recordings');
  for (const name of readdirSync(dir).filter(file => file.endsWith('.json')).sort()) {
    const recording = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Recording;
    const scene = await seedScene(recording.scene);
    if (scene.kind === 'missing') { console.log(`${name}: skipped (${scene.message})`); continue; }
    writeFileSync(join(dir, name), `${JSON.stringify({ ...recording, evidence: comparableEvidence(scene.evidence) }, null, 2)}\n`);
  }
}

if (command === 'requests') await captureRequests();
else if (command === 'refresh') await refreshEvidence();
else if (command === 'review') await reviewRecordings();
else throw new Error('Usage: ai-eval requests|review|refresh ...');
