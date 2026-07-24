/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Neural proposer: the locally installed `claude` CLI in headless print
 * mode, Haiku model, tools disabled, one turn, no session persistence.
 * Every call gets a hard 120 s timeout (a hung CLI counts as a failed
 * proposal) and every prompt/response pair is persisted to the scratchpad
 * for auditability. A global call budget guards runaway loops.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MODEL = 'claude-haiku-4-5-20251001';
// Overridable: raw-IFC emission is token-heavy and can exceed the default
// (a full STEP file is thousands of output tokens vs tens of ops).
export const CALL_TIMEOUT_MS = Number(process.env.M5_CALL_TIMEOUT_MS ?? 120_000);
export const MAX_CALLS = 120;

let callCount = 0;
let rawDir = null;

export function initModel(rawDirectory) {
  rawDir = rawDirectory;
  fs.mkdirSync(rawDir, { recursive: true });
}

export function totalCalls() {
  return callCount;
}

/**
 * One model call. Returns { ok, text?, error?, ms, call } and never throws.
 * `label` names the persisted transcript files.
 */
export function callModel(prompt, label) {
  if (callCount >= MAX_CALLS) {
    return Promise.resolve({ ok: false, error: `model call budget (${MAX_CALLS}) exhausted`, ms: 0, call: callCount });
  }
  callCount += 1;
  const call = callCount;
  const started = Date.now();
  if (rawDir) {
    fs.writeFileSync(path.join(rawDir, `${String(call).padStart(3, '0')}-${label}-prompt.txt`), prompt);
  }

  return new Promise((resolve) => {
    const child = spawn('claude', [
      '-p', prompt,
      '--model', MODEL,
      '--max-turns', '1',
      '--tools', '',
      '--no-session-persistence',
      '--output-format', 'text',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let errOut = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      const ms = Date.now() - started;
      if (rawDir) {
        const body = result.ok ? result.text : `<<FAILED: ${result.error}>>\n${out}\n--- stderr ---\n${errOut}`;
        fs.writeFileSync(path.join(rawDir, `${String(call).padStart(3, '0')}-${label}-response.txt`), body);
      }
      resolve({ ...result, ms, call });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `timeout after ${CALL_TIMEOUT_MS} ms` });
    }, CALL_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: `spawn failed: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish({ ok: false, error: `claude exited ${code}: ${errOut.slice(0, 300)}` });
      } else if (out.trim().length === 0) {
        finish({ ok: false, error: 'claude returned empty output' });
      } else {
        finish({ ok: true, text: out });
      }
    });
  });
}

/**
 * Extract a JSON array from model text: tolerates markdown fences and
 * surrounding prose (first '[' to last ']'). Returns { ok, ops? , error? }.
 * This is transport-level extraction, shared by both arms; grammar
 * validity of the ops themselves is judged by dsl.mjs.
 */
export function extractJsonArray(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const lo = t.indexOf('[');
  const hi = t.lastIndexOf(']');
  if (lo === -1 || hi === -1 || hi <= lo) {
    return { ok: false, error: 'no JSON array found in the response' };
  }
  const candidate = t.slice(lo, hi + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed)) return { ok: false, error: 'top-level JSON value is not an array' };
    return { ok: true, ops: parsed };
  } catch (e) {
    return { ok: false, error: `JSON parse error: ${e.message}` };
  }
}
