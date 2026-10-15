/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live provider calls for the AI evaluation (#6928). Opt-in only: nothing in
 * CI imports a network path. Settings are fixed (temperature 0 where the
 * Assistant sends a temperature: the viewer proxy and current frontier models
 * take none, so their receipts record `null`; the manifest's output ceiling and
 * timeout everywhere) and every call leaves a usage receipt; usage is
 * recorded only when the provider streamed it, never estimated. Credentials
 * come from the environment, are used for one header, and never reach a
 * recording, receipt or log (`assertNoSecrets` refuses to write if one does).
 */

import { checkAnswer, checkRunBudget } from './invariants.mjs';
import { foldEvents, outcomeOf, parseEvents, sseData } from './sse.mjs';
import { privacyFindings } from './manifest.mjs';

export const FIXED_SETTINGS = Object.freeze({ temperature: 0 });
const ANTHROPIC_VERSION = '2023-06-01';
const RESPONSE_TEXT_LIMIT = 1_048_576;
const OUTPUT_INSPECTION_LIMIT = 33_554_432;

class ResponseInspectionBound extends Error {
  constructor() { super('Provider response exceeds the credential inspection bound'); }
}

async function responseText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > RESPONSE_TEXT_LIMIT) {
        try { await reader.cancel(); } catch { throw new ResponseInspectionBound(); }
        throw new ResponseInspectionBound();
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

/** Decode JSON string literals only: no recursive object parsing or nesting walk. */
function decodedCredential(text, knownSecrets) {
  if (text.length > OUTPUT_INSPECTION_LIMIT) throw new Error('Evaluation output exceeds the credential inspection bound');
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') continue;
    const start = index++;
    for (; index < text.length && text[index] !== '"'; index++) {
      if (text[index] === '\\') index++;
    }
    if (index === text.length) throw new Error('Evaluation output has an unsupported quoted string');
    let value;
    try { value = JSON.parse(text.slice(start, index + 1)); }
    catch { throw new Error('Evaluation output has an unsupported JSON string'); }
    if (knownSecrets.some(secret => value.includes(secret))) return true;
  }
  return false;
}

/** Default endpoints; each can be pointed elsewhere (a free OpenAI-compatible host, a local mock) via env. */
export const DEFAULT_URLS = { anthropic: 'https://api.anthropic.com/v1/messages', openai: 'https://api.openai.com/v1/chat/completions' };

/** The provider's wire request for a captured viewer request. Pure; the credential is added by the caller. */
export function wireRequest(kind, { model, request, settings }) {
  const { system, messages, maxOutputTokens } = request;
  const maxTokens = Math.min(maxOutputTokens, settings.maxOutputTokens);
  // The viewer sends sampling params only to models flagged for them; others 400 on a temperature.
  // Captures that predate the field keep the fixed setting: recapture for current frontier models.
  const temperature = request.sentTemperature === false ? {} : { temperature: settings.temperature };
  if (kind === 'anthropic') {
    return { headers: { 'anthropic-version': ANTHROPIC_VERSION },
      body: { model, max_tokens: maxTokens, ...temperature, system, messages, stream: true } };
  }
  if (kind === 'openai') {
    return { headers: {},
      body: { model, max_completion_tokens: maxTokens, ...temperature, stream: true, stream_options: { include_usage: true },
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
export function assertNoSecrets(value, where, knownSecrets = []) {
  const serialized = JSON.stringify(value);
  const sensitive = knownSecrets.filter(secret => typeof secret === 'string' && secret);
  const candidates = typeof value === 'string' ? [value, serialized] : [serialized];
  for (const secret of sensitive) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (candidates.some(candidate => candidate.includes(secret) || candidate.includes(escaped))) {
      throw new Error(`${where}: refusing to write (configured provider credential)`);
    }
  }
  if (sensitive.length && candidates.some(candidate => decodedCredential(candidate, sensitive))) {
    throw new Error(`${where}: refusing to write (configured provider credential)`);
  }
  const findings = privacyFindings(serialized, 'json');
  if (findings.length) throw new Error(`${where}: refusing to write (${findings.join('; ')})`);
}

/** One provider call; returns the recording-shaped response plus its usage receipt. */
export async function callProvider({ provider, task, request, settings, fetchImpl, now, knownSecrets = [] }) {
  const wire = wireRequest(provider.kind, { model: provider.model, request, settings });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const startedAt = now();
  let status = 0;
  let text = '';
  let failure = null;
  try {
    // No redirects: a 3xx would re-send the credential header (Anthropic's x-api-key survives cross-origin); it is recorded as an error.
    const response = await fetchImpl(provider.url, { method: 'POST', signal: controller.signal, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...wire.headers, ...authHeaders(provider.kind, provider.key) }, body: JSON.stringify(wire.body) });
    status = response.status;
    text = await responseText(response);
  } catch (error) {
    if (error instanceof ResponseInspectionBound) throw error;
    failure = controller.signal.aborted ? 'timeout' : `network error: ${error instanceof Error ? error.name : 'unknown'}`;
  } finally { clearTimeout(timer); }
  const finishedAt = now();
  if (text.length > RESPONSE_TEXT_LIMIT) throw new Error('Provider response exceeds the credential inspection bound');
  // Check the actual response before parsing SSE or constructing a receipt.
  // Providers can echo opaque credentials that the generic scanner cannot know.
  const sensitive = [provider.key, ...knownSecrets];
  assertNoSecrets(text, 'provider response', sensitive);
  const ok = status === 200 && failure === null;
  const events = ok ? parseEvents(sseData(text)) : null;
  const folded = events ? foldEvents(provider.kind, events) : { text: '', finishReason: null, usage: null };
  const outcome = failure === 'timeout' ? 'timeout' : failure ? 'error' : outcomeOf(status, folded);
  const receipt = { task: task.id, route: provider.kind, model: provider.model, status, outcome, startedAt, durationMs: finishedAt - startedAt,
    // What was actually sent, not the fixed intent: the proxy and current frontier models get no temperature.
    settings: { temperature: wire.body.temperature ?? null, maxOutputTokens: wire.body.max_tokens ?? wire.body.max_completion_tokens ?? wire.body.maxOutputTokens, timeoutMs: settings.timeoutMs },
    finishReason: folded.finishReason, usageReported: folded.usage !== null,
    ...(folded.usage ? { inputTokens: folded.usage.inputTokens, outputTokens: folded.usage.outputTokens } : {}) };
  const response = ok ? { status, events, done: /data:\s*\[DONE\]/.test(text) }
    : { status: status || 599, body: (failure ?? text).slice(0, 2000) };
  const result = { response, receipt, folded, outcome };
  assertNoSecrets(result, 'provider result', sensitive);
  return result;
}

/**
 * Run the selected tasks against the selected providers within the root
 * budget. `captured` is the viewer exporter's output (`pnpm ai-eval requests`);
 * a provider's own `captured` (made with its model) takes precedence.
 * Returns recordings (corpus `live`), receipts, and per-call invariant results.
 */
export async function runLive({ manifest, captured, providers, tasks, repeats, fetchImpl, now = Date.now, runId }) {
  const settings = { ...FIXED_SETTINGS, maxOutputTokens: manifest.liveEvaluation.maxOutputTokens, timeoutMs: manifest.liveEvaluation.timeoutMs };
  const budget = manifest.liveEvaluation.budget;
  const knownSecrets = providers.map(provider => provider.key);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error(`--repeats must be a whole number of at least 1, got ${repeats}`);
  if (repeats > manifest.liveEvaluation.maxRepeats) throw new Error(`--repeats ${repeats} exceeds the manifest limit of ${manifest.liveEvaluation.maxRepeats}`);
  const recordings = [];
  const receipts = [];
  const results = [];
  let stopped = null;
  const byId = new Map(manifest.tasks.map(task => [task.id, task]));
  const unknown = tasks.filter(id => !byId.has(id));
  if (unknown.length) throw new Error(`Unknown task(s): ${unknown.join(', ')}`);
  // Each provider replays a capture made with its own model: output ceiling and temperature are per model.
  const entries = new Map(providers.map(provider => {
    const capture = provider.captured ?? captured;
    if (!capture) throw new Error(`No captured requests for ${provider.kind}`);
    // A requested task the capture does not contain is refused up front, never silently dropped from the counts.
    const missing = tasks.filter(id => !capture.tasks.some(item => item.taskId === id));
    if (missing.length) throw new Error(`The ${provider.kind} capture has no entry for: ${missing.join(', ')}. Recapture with pnpm ai-eval requests.`);
    return [provider, new Map(capture.tasks.map(item => [item.taskId, item]))];
  }));
  for (const task of [...new Set(tasks)].map(id => byId.get(id))) {
    for (const provider of providers) {
      const entry = entries.get(provider).get(task.id);
      if (entry.skipped) { results.push({ task: task.id, route: provider.kind, skipped: entry.skipped }); continue; }
      for (let repeat = 1; repeat <= repeats; repeat++) {
        if (receipts.length + 1 > budget.maxRequests) { stopped = `request budget of ${budget.maxRequests} reached`; break; }
        if (checkRunBudget(receipts, budget).violations.length) { stopped = 'output token budget reached'; break; }
        const call = await callProvider({ provider, task, request: entry.request, settings, fetchImpl, now, knownSecrets });
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
    if (stopped) break;
  }
  const run = checkRunBudget(receipts, budget);
  assertNoSecrets({ recordings, receipts, results }, 'live evaluation output', providers.map(provider => provider.key));
  // The fixed temperature is an upper bound on what was sent: receipts record each actual value.
  const { temperature, ...limits } = settings;
  return { runId, settings: { ...limits, fixedTemperature: temperature, temperatureSent: 'only where the Assistant sends one; see receipts' }, recordings, receipts, results, run, stopped };
}
