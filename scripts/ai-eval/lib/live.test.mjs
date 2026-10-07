/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertNoSecrets, callProvider, resolveProvider, runLive, wireRequest } from './live.mjs';
import { REPO_ROOT, recordingErrors } from './recording.mjs';
import { readJson } from './test-root.mjs';

const manifest = readJson(join(REPO_ROOT, 'tests', 'ai-eval', 'manifest.json'));
const evidence = { source: 'clash', totalRows: 2, includedRows: 2, evidence: { rows: [{ citation: 'E1', data: {} }, { citation: 'E2', data: {} }] } };
const captured = { version: 1, tasks: [
  { taskId: 'clash-summary', scene: 'clash-rev-b', evidence, request: { system: 'SYSTEM', messages: [{ role: 'user', content: 'Summarize' }], maxOutputTokens: 4096 } },
  { taskId: 'clash-grouping', scene: 'clash-rev-b', evidence, request: { system: 'SYSTEM', messages: [{ role: 'user', content: 'Group' }], maxOutputTokens: 4096 } },
  { taskId: 'validation-explain-fzk', skipped: 'Run pnpm fixtures to fetch AC20-FZK-Haus.ifc' }] };

const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
const chatStream = (text, usage) => sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, ...(usage ? [{ choices: [], usage }] : [])]);
const reply = (body, status = 200) => async () => new Response(body, { status });
const provider = { kind: 'openai', url: 'https://example.invalid/v1/chat', model: 'free-model', key: 'test-key-never-persisted-0123456789' };
const common = { manifest, captured, providers: [provider], tasks: ['clash-summary', 'clash-grouping', 'validation-explain-fzk'], repeats: 1, runId: 't1' };

test('wireRequest fixes temperature and the output ceiling per provider and never exceeds the manifest ceiling', () => {
  const settings = { temperature: 0, maxOutputTokens: 1000 };
  const request = captured.tasks[0].request;
  const anthropic = wireRequest('anthropic', { model: 'm', request, settings });
  assert.deepEqual([anthropic.body.max_tokens, anthropic.body.temperature, anthropic.body.stream, anthropic.body.system], [1000, 0, true, 'SYSTEM']);
  const openai = wireRequest('openai', { model: 'm', request, settings });
  assert.deepEqual(openai.body.messages[0], { role: 'system', content: 'SYSTEM' });
  assert.equal(openai.body.max_completion_tokens, 1000);
  assert.equal(openai.body.stream_options.include_usage, true);
  assert.equal(wireRequest('proxy', { model: 'm', request, settings }).body.maxOutputTokens, 1000);
});

test('resolveProvider reports what is missing instead of guessing, and the proxy needs no credential', () => {
  const entries = Object.fromEntries(manifest.liveEvaluation.providers.map(entry => [entry.kind, entry]));
  assert.match(resolveProvider(entries.openai, {}).reason, /IFCLITE_AI_EVAL_OPENAI_MODEL/);
  assert.match(resolveProvider(entries.openai, { IFCLITE_AI_EVAL_OPENAI_MODEL: 'm' }).reason, /OPENAI_API_KEY/);
  assert.equal(resolveProvider(entries.anthropic, { IFCLITE_AI_EVAL_ANTHROPIC_MODEL: 'm', ANTHROPIC_API_KEY: 'k' }).url, 'https://api.anthropic.com/v1/messages');
  assert.match(resolveProvider(entries.proxy, { IFCLITE_AI_EVAL_PROXY_MODEL: 'm' }).reason, /IFCLITE_AI_EVAL_PROXY_URL/);
  assert.equal(resolveProvider(entries.proxy, { IFCLITE_AI_EVAL_PROXY_MODEL: 'm', IFCLITE_AI_EVAL_PROXY_URL: 'http://localhost:1/api/chat' }).key, null);
});

test('a live run sends the credential in one header only, fixes settings, and records a valid unreviewed recording with a usage receipt', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return new Response(chatStream('Two findings: [E1] and [E2].', { prompt_tokens: 900, completion_tokens: 12 })); };
  const outcome = await runLive({ ...common, fetchImpl });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers.Authorization, `Bearer ${provider.key}`);
  assert.equal(seen[0].body.temperature, 0);
  assert.equal(seen[0].body.max_completion_tokens, manifest.liveEvaluation.maxOutputTokens);
  assert.ok(!JSON.stringify(seen[0].body).includes(provider.key), 'the key never enters the request body');
  assert.ok(!JSON.stringify(outcome).includes(provider.key), 'the key never enters any output');
  assert.deepEqual(outcome.results.at(-1), { task: 'validation-explain-fzk', skipped: 'Run pnpm fixtures to fetch AC20-FZK-Haus.ifc' });
  const [first] = outcome.recordings;
  assert.deepEqual(recordingErrors(first), []);
  assert.equal(first.corpus, 'live');
  assert.equal(first.provenance.receipt.inputTokens, 900);
  assert.equal(first.provenance.receipt.settings.maxOutputTokens, 4096);
  assert.equal(outcome.run.reportedOutputTokens, 24);
  assert.equal(outcome.results[0].violations.length, 0);
});

test('usage the provider did not stream is recorded as unreported, never estimated', async () => {
  const outcome = await runLive({ ...common, tasks: ['clash-summary'], fetchImpl: reply(chatStream('See [E1].')) });
  assert.equal(outcome.receipts[0].usageReported, false);
  assert.equal('outputTokens' in outcome.receipts[0], false);
  assert.deepEqual([outcome.run.reportedOutputTokens, outcome.run.unreported], [0, 1]);
});

test('live answers go through the same invariants as the corpus', async () => {
  const outcome = await runLive({ ...common, tasks: ['clash-summary'], fetchImpl: reply(chatStream('I have created issues for [E9].')) });
  assert.deepEqual(outcome.results[0].violations.map(violation => violation.id).sort(), ['citations-valid', 'no-effect-claims']);
});

test('HTTP errors and timeouts become error recordings and receipts; no credential or body leaks', async () => {
  const failed = await runLive({ ...common, tasks: ['clash-summary'], fetchImpl: reply('{"error":"rate limited"}', 429) });
  assert.equal(failed.receipts[0].outcome, 'error');
  assert.deepEqual([failed.recordings[0].response.status, failed.results[0].violations], [429, null]);
  assert.deepEqual(recordingErrors(failed.recordings[0]), []);

  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = structuredClone(manifest);
  slow.liveEvaluation.timeoutMs = 20;
  const timedOut = await runLive({ ...common, manifest: slow, tasks: ['clash-summary'], fetchImpl: hang });
  assert.equal(timedOut.receipts[0].outcome, 'timeout');
});

test('the root budget stops the run before it exceeds the request limit, and repeats above the manifest limit are refused', async () => {
  const tight = structuredClone(manifest);
  tight.liveEvaluation.budget.maxRequests = 1;
  let calls = 0;
  const outcome = await runLive({ ...common, manifest: tight, fetchImpl: async () => { calls++; return new Response(chatStream('ok [E1]')); } });
  assert.equal(calls, 1);
  assert.match(outcome.stopped, /request budget of 1/);
  await assert.rejects(runLive({ ...common, repeats: manifest.liveEvaluation.maxRepeats + 1, fetchImpl: reply('') }), /exceeds the manifest limit/);
});

test('a run that reached the output-token budget stops before the next request', async () => {
  const tight = structuredClone(manifest);
  tight.liveEvaluation.budget.maxOutputTokens = 10;
  let calls = 0;
  const outcome = await runLive({ ...common, manifest: tight, fetchImpl: async () => { calls++; return new Response(chatStream('ok [E1]', { prompt_tokens: 1, completion_tokens: 50 })); } });
  assert.equal(calls, 1);
  assert.match(outcome.stopped, /output token budget/);
});

test('output containing a credential-like token or e-mail address is refused, not written', async () => {
  await assert.rejects(runLive({ ...common, tasks: ['clash-summary'], fetchImpl: reply(chatStream('Use sk-ant-abcdefghijklmnopqrstuvwx [E1]')) }), /refusing to write.*credential-like/);
  assert.throws(() => assertNoSecrets({ a: 'mail me@example.com' }, 'x'), /e-mail address/);
});

test('callProvider reports a network failure by class only', async () => {
  const call = await callProvider({ provider, task: { id: 't' }, request: captured.tasks[0].request, settings: { temperature: 0, maxOutputTokens: 100, timeoutMs: 1000 },
    fetchImpl: async () => { throw new TypeError(`connect failed for key ${provider.key}`); }, now: () => 5 });
  assert.equal(call.receipt.outcome, 'error');
  assert.ok(!JSON.stringify(call).includes(provider.key));
});

test('a run refuses non-positive or non-numeric repeats and tasks the capture does not contain, before any request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('no request expected'); };
  for (const repeats of [0, -1, Number.NaN, 1.5]) {
    await assert.rejects(runLive({ ...common, repeats, fetchImpl }), /--repeats must be a whole number/);
  }
  await assert.rejects(runLive({ ...common, tasks: ['clash-summary', 'not-captured-task'], fetchImpl }), /no entry for: not-captured-task/);
  assert.equal(calls, 0);
});
