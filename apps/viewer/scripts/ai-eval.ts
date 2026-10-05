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
import { replaceEvidence } from '../src/lib/assistant/conversation.js';
import { sendAssistant } from '../src/lib/assistant/request.js';
import { comparableEvidence, isAiEvalScene, seedScene } from '../src/test/ai-eval-scenes.js';
import { replayRecording, type Recording } from '../src/test/ai-eval-replay.js';
import { reviewReplay } from '../src/test/ai-eval-review.js';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};
const required = (name: string) => {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required`);
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
};

interface Task { id: string; scene: string; prompt: string }

/** Proxy and Anthropic system prompts may be cache-marked blocks; the runner needs the plain text. */
function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map(block => (block as { text?: unknown }).text).filter(text => typeof text === 'string').join('');
  throw new Error('Captured request has no system prompt');
}

async function captureRequests(): Promise<void> {
  const manifest = JSON.parse(readFileSync(required('manifest'), 'utf8')) as { tasks: Task[] };
  const model = flag('model');
  if (!model) throw new Error('--model is required (the live model id, so output ceilings match)');
  const only = flag('tasks')?.split(',');
  const out: unknown[] = [];
  for (const task of manifest.tasks.filter(item => !only || only.includes(item.id))) {
    if (!isAiEvalScene(task.scene)) throw new Error(`${task.id}: unknown scene ${task.scene}`);
    const scene = await seedScene(task.scene);
    if (scene.kind === 'missing') { out.push({ taskId: task.id, skipped: scene.message }); continue; }
    replaceEvidence(scene.evidence);
    let body: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: {"choices":[{"delta":{"content":"captured"},"finish_reason":"stop"}]}\n\n');
    }) as typeof fetch;
    try { await sendAssistant(task.prompt, model, '/api/chat'); }
    finally { globalThis.fetch = originalFetch; }
    const captured = body as Record<string, unknown> | null;
    if (!captured) throw new Error(`${task.id}: the Assistant refused to send (check prompt and scene)`);
    out.push({ taskId: task.id, scene: task.scene, evidence: comparableEvidence(scene.evidence),
      request: { system: systemText(captured.system), messages: captured.messages, maxOutputTokens: captured.maxOutputTokens } });
  }
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
