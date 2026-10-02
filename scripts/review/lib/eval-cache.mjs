/* SPDX-License-Identifier: MPL-2.0 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewReasoning } from './review-reasoning.mjs';
import { REVIEWER_FAULT } from '../eval-validation.mjs';

// Only completed model attempts are reusable. A transport failure during a
// corrective retry is not a completed case, even if its first raw answer exists.
export function readEvalCache(dir, name, input, model, profile = 'high') {
  const path = (suffix) => join(dir, `${name}.${suffix}`);
  if (!['input.json', 'out.txt', 'validation.json', 'out.txt.telemetry.jsonl'].every((suffix) => existsSync(path(suffix)))) return null;
  const saved = JSON.parse(readFileSync(path('input.json'), 'utf8'));
  if (saved.headSha !== input.headSha || JSON.stringify(saved.files) !== JSON.stringify(input.files)) throw new Error(`Cached case ${name} does not match the corpus.`);
  const validation = JSON.parse(readFileSync(path('validation.json'), 'utf8'));
  if (validation.reviewerFailure) return null;
  const calls = readFileSync(path('out.txt.telemetry.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  if (calls.some((call) => call.model !== model)) throw new Error(`Cached case ${name} belongs to a different model.`);
  if (calls.some((call) => JSON.stringify(call.reasoning ?? { effort: 'high' }) !== JSON.stringify(reviewReasoning(model, profile)))) throw new Error(`Cached case ${name} belongs to a different reasoning profile.`);
  if (calls.some((call) => call.answered === false)) return null;
  if (![1, 2].includes(validation.attempts) || calls.length < validation.attempts) return null;
  if (validation.reason !== null && !REVIEWER_FAULT.has(validation.reason)) return null;
  return { input: saved, attempts: validation.attempts };
}

// A run's head SHA is not necessarily the tree selected by context_ref.
// Require the saved context evidence rather than silently mixing trees.
export function readEvalContext(dir) {
  const receipt = join(dir, 'eval-context.txt');
  const score = join(dir, 'eval', 'score.json');
  const ref = existsSync(receipt) ? readFileSync(receipt, 'utf8').trim()
    : existsSync(score) ? JSON.parse(readFileSync(score, 'utf8')).baseRef : null;
  if (typeof ref !== 'string' || !/^[0-9a-f]{40}$/.test(ref)) throw new Error('Resumed run has no pinned context tree.');
  return ref;
}
