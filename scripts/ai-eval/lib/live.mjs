/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live provider calls for the AI evaluation (#6928). Opt-in only: nothing in
 * CI imports a network path. Settings are fixed (temperature 0, the manifest's
 * output ceiling and timeout) and every call leaves a usage receipt; usage is
 * recorded only when the provider streamed it, never estimated. Credentials
 * come from the environment, are used for one header, and never reach a
 * recording, receipt or log (`assertNoSecrets` refuses to write if one does).
 */

import { checkAnswer, checkRunBudget } from './invariants.mjs';
import { foldEvents, outcomeOf, parseEvents, sseData } from './sse.mjs';
import { privacyFindings } from './manifest.mjs';

export const FIXED_SETTINGS = Object.freeze({ temperature: 0 });
const ANTHROPIC_VERSION = '2023-06-01';

/** Default endpoints; each can be pointed elsewhere (a free OpenAI-compatible host, a local mock) via env. */
export const DEFAULT_URLS = { anthropic: 'https://api.anthropic.com/v1/messages', openai: 'https://api.openai.com/v1/chat/completions' };

/** The provider's wire request for a captured viewer request. Pure; the credential is added by the caller. */
export function wireRequest(kind, { model, request, settings }) {
  const { system, messages, maxOutputTokens } = request;
  const maxTokens = Math.min(maxOutputTokens, settings.maxOutputTokens);
  if (kind === 'anthropic') {
    return { headers: { 'anthropic-version': ANTHROPIC_VERSION },
      body: { model, max_tokens: maxTokens, temperature: settings.temperature, system, messages, stream: true } };
  }
  if (kind === 'openai') {
    return { headers: {},
      body: { model, max_completion_tokens: maxTokens, temperature: settings.temperature, stream: true, stream_options: { include_usage: true },
        messages: [{ role: 'system', content: system }, ...messages] } };
  }
  return { headers: {}, body: { model, maxOutputTokens: maxTokens, system, messages } };
}

/** Resolve a provider entry of the manifest against the environment; null with a reason when it cannot run. */
export function resolveProvider(provider, env) {
  const upper = provider.kind.toUpperCase();
  const url = env[`IFCLITE_AI_EVAL_${upper}_URL`] ?? DEFAULT_URLS[provider.kind];
  const model = env[`IFCLITE_AI_EVAL_${upper}_MODEL`];
  if (!url) return { reason: `set IFCLITE_AI_EVAL_${upper}_URL` };
  if (!model) return { reason: `set IFCLITE_AI_EVAL_${upper}_MODEL` };
  const key = provider.credential === 'none' ? null : env[provider.credential];
  if (provider.credential !== 'none' && !key) return { reason: `set ${provider.credential}` };
  return { kind: provider.kind, url, model, key };
}

function authHeaders(kind, key) {
  if (!key) return {};
  return kind === 'anthropic' ? { 'x-api-key': key } : { Authorization: `Bearer ${key}` };
}

/** Refuse to persist anything that looks like a credential or personal address. */
export function assertNoSecrets(value, where) {
  const findings = privacyFindings(JSON.stringify(value), 'json');
  if (findings.length) throw new Error(`${where}: refusing to write (${findings.join('; ')})`);
}

/** One provider call; returns the recording-shaped response plus its usage receipt. */
export async function callProvider({ provider, task, request, settings, fetchImpl, now }) {
  const wire = wireRequest(provider.kind, { model: provider.model, request, settings });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const startedAt = now();
  let status = 0;
  let text = '';
  let failure = null;
  try {
    const response = await fetchImpl(provider.url, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...wire.headers, ...authHeaders(provider.kind, provider.key) }, body: JSON.stringify(wire.body) });
    status = response.status;
    text = await response.text();
  } catch (error) {
    failure = controller.signal.aborted ? 'timeout' : `network error: ${error instanceof Error ? error.name : 'unknown'}`;
  } finally { clearTimeout(timer); }
  const finishedAt = now();
  const ok = status === 200 && failure === null;
  const events = ok ? parseEvents(sseData(text)) : null;
  const folded = events ? foldEvents(provider.kind, events) : { text: '', finishReason: null, usage: null };
  const outcome = failure === 'timeout' ? 'timeout' : failure ? 'error' : outcomeOf(status, folded);
  const receipt = { task: task.id, route: provider.kind, model: provider.model, status, outcome, startedAt, durationMs: finishedAt - startedAt,
    settings: { temperature: settings.temperature, maxOutputTokens: wire.body.max_tokens ?? wire.body.max_completion_tokens ?? wire.body.maxOutputTokens, timeoutMs: settings.timeoutMs },
    finishReason: folded.finishReason, usageReported: folded.usage !== null,
    ...(folded.usage ? { inputTokens: folded.usage.inputTokens, outputTokens: folded.usage.outputTokens } : {}) };
  const response = ok ? { status, events, done: /data:\s*\[DONE\]/.test(text) }
    : { status: status || 599, body: (failure ?? text).slice(0, 2000) };
  return { response, receipt, folded, outcome };
}

/**
 * Run the selected tasks against the selected providers within the root
 * budget. `captured` is the viewer exporter's output (`pnpm ai-eval requests`).
 * Returns recordings (corpus `live`), receipts, and per-call invariant results.
 */
export async function runLive({ manifest, captured, providers, tasks, repeats, fetchImpl, now = Date.now, runId }) {
  const settings = { ...FIXED_SETTINGS, maxOutputTokens: manifest.liveEvaluation.maxOutputTokens, timeoutMs: manifest.liveEvaluation.timeoutMs };
  const budget = manifest.liveEvaluation.budget;
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error(`--repeats must be a whole number of at least 1, got ${repeats}`);
  if (repeats > manifest.liveEvaluation.maxRepeats) throw new Error(`--repeats ${repeats} exceeds the manifest limit of ${manifest.liveEvaluation.maxRepeats}`);
  const recordings = [];
  const receipts = [];
  const results = [];
  let stopped = null;
  const byId = new Map(manifest.tasks.map(task => [task.id, task]));
  // A requested task the capture does not contain is refused up front, never silently dropped from the counts.
  const missing = tasks.filter(id => !captured.tasks.some(item => item.taskId === id));
  if (missing.length) throw new Error(`The captured requests file has no entry for: ${missing.join(', ')}. Recapture with pnpm ai-eval requests.`);
  for (const entry of captured.tasks.filter(item => tasks.includes(item.taskId))) {
    if (entry.skipped) { results.push({ task: entry.taskId, skipped: entry.skipped }); continue; }
    const task = byId.get(entry.taskId);
    for (const provider of providers) for (let repeat = 1; repeat <= repeats; repeat++) {
      if (receipts.length + 1 > budget.maxRequests) { stopped = `request budget of ${budget.maxRequests} reached`; break; }
      if (checkRunBudget(receipts, budget).violations.length) { stopped = 'output token budget reached'; break; }
      const call = await callProvider({ provider, task, request: entry.request, settings, fetchImpl, now });
      receipts.push(call.receipt);
      const id = `${runId}-${task.id}-${provider.kind}-${repeat}`;
      const recording = { $schema: '../../../recording.schema.json', version: 1, id: `live-${id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80), task: task.id, scene: entry.scene,
        corpus: 'live', prompt: task.prompt, route: { kind: provider.kind, model: provider.model },
        provenance: { kind: 'live', recordedAt: new Date(call.receipt.startedAt).toISOString().slice(0, 10), note: `Unreviewed live run ${runId}, repeat ${repeat}.`, receipt: call.receipt },
        response: call.response, evidence: entry.evidence };
      recordings.push(recording);
      const checked = call.outcome === 'error' || call.outcome === 'timeout' ? null
        : checkAnswer({ text: call.folded.text, source: entry.evidence.source, evidence: entry.evidence, usage: call.folded.usage, maxOutputTokens: call.receipt.settings.maxOutputTokens });
      results.push({ task: task.id, route: provider.kind, repeat, recording: recording.id, outcome: call.outcome,
        violations: checked ? checked.violations : null, facts: checked ? checked.facts : null });
    }
    if (stopped) break;
  }
  const run = checkRunBudget(receipts, budget);
  assertNoSecrets({ recordings, receipts, results }, 'live evaluation output');
  return { runId, settings, recordings, receipts, results, run, stopped };
}
