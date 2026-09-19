/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runEnsemble,
  poolFindings,
  runEnsembleReview,
  resolveEnsembleModels,
  resolveEnsemblePlan,
  maybeRunEnsemble,
  estimateCostUsd,
  MODEL_PRICES_PER_MTOK,
  REVIEW_ENSEMBLE_STRONG_MODEL,
} from './ensemble-reviewer.mjs';

const SENTINEL = 'ifc-lite-review-v1';
const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const clean = () => ({
  verdict: 'clean',
  files_reviewed: ['a.ts'],
  riskiest_change: { path: 'a.ts', quoted_line: 'const x = 1;' },
  findings: [],
  end: SENTINEL,
});
const withFinding = (body = 'a real defect here') => ({
  verdict: 'findings',
  files_reviewed: ['a.ts'],
  riskiest_change: { path: 'a.ts', quoted_line: 'const x = 1;' },
  findings: [{ path: 'a.ts', line: 3, quote: 'const x = 1;', body, class: 'bug' }],
  end: SENTINEL,
});

// ============================================================== runEnsemble

test('all models succeed: every result is captured, no failures', async () => {
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    return reply({ choices: [{ message: { content: JSON.stringify(clean()) } }], usage: { prompt_tokens: 100, completion_tokens: 50 }, _model: model });
  };
  const { results, failures } = await runEnsemble({ prompt: 'p', apiKey: 'k', models: ['a/one', 'b/two'], fetchImpl });
  assert.equal(results.length, 2);
  assert.equal(failures.length, 0);
  assert.deepEqual(results.map((r) => r.model).sort(), ['a/one', 'b/two']);
});

test('one model fails: the other still returns, and the failure is recorded', async () => {
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    if (model === 'bad/model') return reply({ error: { message: 'no credits' } });
    return { ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'no credits' } }) };
  };
  // Make one succeed and one fail explicitly.
  const fetchImpl2 = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    if (model === 'good/model') return reply({ choices: [{ message: { content: JSON.stringify(clean()) } }] });
    return { ok: false, status: 500, text: async () => 'server error' };
  };
  const { results, failures } = await runEnsemble({ prompt: 'p', apiKey: 'k', models: ['good/model', 'bad/model'], fetchImpl: fetchImpl2 });
  assert.equal(results.length, 1);
  assert.equal(results[0].model, 'good/model');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].model, 'bad/model');
  assert.match(failures[0].error, /HTTP 500/);
});

test('all models fail: results is empty, minSuccess is not met', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'down' });
  const { results, failures } = await runEnsemble({ prompt: 'p', apiKey: 'k', models: ['a/one', 'b/two'], minSuccess: 1, fetchImpl });
  assert.equal(results.length, 0);
  assert.equal(failures.length, 2);
});

test('runEnsemble refuses an empty model list', async () => {
  await assert.rejects(runEnsemble({ prompt: 'p', apiKey: 'k', models: [] }), /at least one model/);
});

// ============================================================= poolFindings

test('source tagging: every pooled finding carries the model that produced it', () => {
  const results = [
    { model: 'a/one', text: JSON.stringify(withFinding('finding from a')) },
    { model: 'b/two', text: JSON.stringify(withFinding('finding from b')) },
  ];
  const pooled = poolFindings(results);
  assert.equal(pooled.findings.length, 2);
  assert.deepEqual(pooled.findings.map((f) => f.source).sort(), ['a/one', 'b/two']);
  assert.equal(pooled.verdict, 'findings');
  assert.equal(pooled.end, SENTINEL);
});

test('clean only if EVERY parseable model reported clean', () => {
  const allClean = poolFindings([
    { model: 'a/one', text: JSON.stringify(clean()) },
    { model: 'b/two', text: JSON.stringify(clean()) },
  ]);
  assert.equal(allClean.verdict, 'clean');
  assert.equal(allClean.findings.length, 0);

  const oneReportsFindings = poolFindings([
    { model: 'a/one', text: JSON.stringify(clean()) },
    { model: 'b/two', text: JSON.stringify(withFinding()) },
  ]);
  assert.equal(oneReportsFindings.verdict, 'findings');
  assert.equal(oneReportsFindings.findings.length, 1);
  assert.equal(oneReportsFindings.findings[0].source, 'b/two');
});

test('an unparseable model answer is skipped, not fatal to pooling', () => {
  const pooled = poolFindings([
    { model: 'a/one', text: 'not json at all' },
    { model: 'b/two', text: JSON.stringify(clean()) },
  ]);
  assert.equal(pooled.verdict, 'clean');
});

test('poolFindings returns null when nothing parsed', () => {
  assert.equal(poolFindings([{ model: 'a/one', text: 'garbage' }]), null);
});

// ========================================================= runEnsembleReview

test('runEnsembleReview falls through (returns null) when fewer than minSuccess models answer', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'down' });
  const outcome = await runEnsembleReview({ prompt: 'p', apiKey: 'k', models: ['a/one'], minSuccess: 1, fetchImpl });
  assert.equal(outcome, null);
});

test('runEnsembleReview returns pooled text and the list of models that answered', async () => {
  const fetchImpl = async (_url, init) => {
    const model = JSON.parse(init.body).model;
    return reply({ choices: [{ message: { content: JSON.stringify(withFinding(`from ${model}`)) } }] });
  };
  const outcome = await runEnsembleReview({ prompt: 'p', apiKey: 'k', models: ['a/one', 'b/two'], fetchImpl });
  assert.ok(outcome);
  const parsed = JSON.parse(outcome.text);
  assert.equal(parsed.findings.length, 2);
  assert.deepEqual(outcome.models.sort(), ['a/one', 'b/two']);
  assert.equal(outcome.failed.length, 0);
});

// =============================================================== cost table

test('estimateCostUsd multiplies the usage field by the hardcoded table, and is null for an unknown model', () => {
  const cost = estimateCostUsd('deepseek/deepseek-v4-flash', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.equal(cost, MODEL_PRICES_PER_MTOK['deepseek/deepseek-v4-flash'].in + MODEL_PRICES_PER_MTOK['deepseek/deepseek-v4-flash'].out);
  assert.equal(estimateCostUsd('unknown/model', { prompt_tokens: 1, completion_tokens: 1 }), null);
  assert.equal(estimateCostUsd('deepseek/deepseek-v4-flash', null), null);
});

// ======================================================== resolveEnsembleModels

test('resolveEnsembleModels: unset or empty means disabled, never a built-in default', () => {
  assert.deepEqual(resolveEnsembleModels({}), []);
  assert.deepEqual(resolveEnsembleModels({ REVIEW_ENSEMBLE_MODELS: '' }), []);
  assert.deepEqual(resolveEnsembleModels({ REVIEW_ENSEMBLE_MODELS: 'a/one,b/two' }), ['a/one', 'b/two']);
});

// ========================================================= resolveEnsemblePlan

test('resolveEnsemblePlan is null without an OpenRouter key even if models are configured', () => {
  assert.equal(resolveEnsemblePlan({ REVIEW_ENSEMBLE_MODELS: 'a/one' }, { files: [] }), null);
});

test('resolveEnsemblePlan is null when REVIEW_ENSEMBLE_MODELS is unset', () => {
  assert.equal(resolveEnsemblePlan({ OPENROUTER_API_KEY: 'k' }, { files: [] }), null);
});

test('resolveEnsemblePlan adds the strong model on a high-risk PR only under REVIEW_ENSEMBLE_STRONG_ON_RISK', () => {
  const env = { OPENROUTER_API_KEY: 'k', REVIEW_ENSEMBLE_MODELS: 'a/one', REVIEW_ENSEMBLE_STRONG_ON_RISK: 'true' };
  const highRisk = { files: [{ path: 'rust/geometry/src/kernel/mod.rs' }] };
  const plan = resolveEnsemblePlan(env, highRisk);
  assert.ok(plan.models.includes(REVIEW_ENSEMBLE_STRONG_MODEL));
});

test('resolveEnsemblePlan leaves the chain alone on a low-risk PR', () => {
  const env = { OPENROUTER_API_KEY: 'k', REVIEW_ENSEMBLE_MODELS: 'a/one', REVIEW_ENSEMBLE_STRONG_ON_RISK: 'true' };
  const lowRisk = { files: [{ path: 'docs/guide/foo.md' }] };
  const plan = resolveEnsemblePlan(env, lowRisk);
  assert.deepEqual(plan.models, ['a/one']);
});

test('resolveEnsemblePlan never adds the strong model without REVIEW_ENSEMBLE_STRONG_ON_RISK', () => {
  const env = { OPENROUTER_API_KEY: 'k', REVIEW_ENSEMBLE_MODELS: 'a/one' };
  const highRisk = { files: [{ path: 'rust/geometry/src/kernel/mod.rs' }] };
  const plan = resolveEnsemblePlan(env, highRisk);
  assert.deepEqual(plan.models, ['a/one']);
});

// ============================================================ maybeRunEnsemble

test('maybeRunEnsemble returns false and writes nothing when disabled', async () => {
  let wrote = false;
  const outPath = { toString: () => { wrote = true; return ''; } };
  const handled = await maybeRunEnsemble({ env: {}, input: { files: [] }, prompt: 'p', outPath });
  assert.equal(handled, false);
  assert.equal(wrote, false);
});
