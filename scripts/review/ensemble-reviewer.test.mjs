/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { DEFECT_CLASSES, MIN_WHY_CHARS } from './lib/defect-classes.mjs';
import { addedLineRanges } from './build-review-input.mjs';

const SENTINEL = 'ifc-lite-review-v1';
const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const clean = () => ({
  verdict: 'clean',
  files_reviewed: ['a.ts'],
  riskiest_change: { path: 'a.ts', quoted_line: 'const x = 1;' },
  findings: [],
  class_pass: DEFECT_CLASSES.map((c) => ({ class: c, verdict: 'clear', why: `checked every hunk for ${c}, nothing found` })),
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

// ============================================= finding-3: the sentinel is not repairable

test('finding-3: a response with NO end sentinel is excluded from the pool, not replaced by one', () => {
  const truncated = withFinding('a real defect here');
  delete truncated.end;
  const results = [
    { model: 'a/one', text: JSON.stringify(clean()) },
    { model: 'truncated/model', text: JSON.stringify(truncated) },
  ];
  const logged = [];
  const origLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  let pooled;
  try {
    pooled = poolFindings(results);
  } finally {
    console.log = origLog;
  }
  assert.equal(pooled.verdict, 'clean', 'the truncated model must not source a finding it never proved');
  assert.equal(pooled.findings.length, 0);
  assert.ok(
    logged.some((l) => l.includes('truncated/model') && l.includes('sentinel')),
    'the exclusion must be logged',
  );
});

test('finding-3: a response with the WRONG end sentinel is excluded, same as a missing one', () => {
  const wrongSentinel = { ...withFinding(), end: 'ifc-lite-review-v1-partial' };
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(clean()) },
    { model: 'bad-end/model', text: JSON.stringify(wrongSentinel) },
  ]);
  assert.equal(pooled.verdict, 'clean');
  assert.equal(pooled.findings.length, 0);
});

test('finding-3: a pool where ONLY a bad-sentinel model answered returns null', () => {
  const truncated = withFinding();
  delete truncated.end;
  assert.equal(poolFindings([{ model: 'truncated/model', text: JSON.stringify(truncated) }]), null);
});

// ============================== round 3: roster, incomplete clean, verdict normalisation

test('round-3: a model whose files_reviewed is not the roster sent is excluded, the other model sources the metadata', () => {
  const short = withFinding('from the model that stopped early');
  short.files_reviewed = ['a.ts'];
  const full = clean();
  full.files_reviewed = ['a.ts', 'b.ts'];
  const pooled = poolFindings(
    [
      { model: 'short/one', text: JSON.stringify(short) },
      { model: 'full/two', text: JSON.stringify(full) },
    ],
    ['a.ts', 'b.ts'],
  );
  assert.deepEqual(pooled.files_reviewed, ['a.ts', 'b.ts']);
  assert.equal(pooled.findings.length, 0, 'the early-stopped model contributes nothing');
  assert.equal(pooled.verdict, 'clean');
});

test('round-3: without a roster the caller passes nothing and every schema-valid model still pools', () => {
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(withFinding('finding from a')) },
    { model: 'b/two', text: JSON.stringify(clean()) },
  ]);
  assert.equal(pooled.findings.length, 1);
});

test('round-3: a clean answer WITHOUT class_pass is excluded, so an all-such pool returns null', () => {
  const incomplete = clean();
  delete incomplete.class_pass;
  assert.equal(poolFindings([{ model: 'a/one', text: JSON.stringify(incomplete) }]), null);
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(incomplete) },
    { model: 'b/two', text: JSON.stringify(clean()) },
  ]);
  assert.equal(pooled.verdict, 'clean');
  assert.ok(Array.isArray(pooled.class_pass));
});

test('round-3: verdict follows the merged findings, so "findings" with an empty array cannot poison a clean pool', () => {
  const emptyFindings = withFinding();
  emptyFindings.findings = [];
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(emptyFindings) },
    { model: 'b/two', text: JSON.stringify(clean()) },
  ]);
  assert.equal(pooled.findings.length, 0);
  assert.equal(pooled.verdict, 'clean');
  const withOne = poolFindings([
    { model: 'a/one', text: JSON.stringify(withFinding('one real defect')) },
    { model: 'b/two', text: JSON.stringify(clean()) },
  ]);
  assert.equal(withOne.verdict, 'findings');
});

// ==================================================== finding-6/7/8: schema and class_pass

/**
 * A DOCS-ONLY diff (mirrors validate-findings.test.mjs's own DOCS_PATCH), so
 * every one of `DEFECT_CLASSES` is legitimately `not-applicable` and a real
 * `class_pass` array can be built without needing `class-applicability.mjs`'s
 * predicates to fire on anything.
 */
const DOCS_PATCH = ['@@ -1,2 +1,4 @@', ' # Title', '+Some prose about the project.', '+More prose here.'].join('\n');
const DOCS_PATH = 'docs/readme.md';
const DOCS_QUOTE = 'Some prose about the project.';

const allNotApplicableClassPass = () =>
  DEFECT_CLASSES.map((c) => ({ class: c, verdict: 'not-applicable', why: `neither hunk can carry ${c}, docs-only diff` }));

const cleanDocsAnswer = () => ({
  verdict: 'clean',
  files_reviewed: [DOCS_PATH],
  riskiest_change: { path: DOCS_PATH, quoted_line: DOCS_QUOTE },
  findings: [],
  class_pass: allNotApplicableClassPass(),
  end: SENTINEL,
});

test('finding-6: a schema-invalid model (empty files_reviewed, no riskiest_change) is excluded from the pool', () => {
  const results = [
    { model: 'good/one', text: JSON.stringify(cleanDocsAnswer()) },
    { model: 'good/two', text: JSON.stringify(cleanDocsAnswer()) },
    // Syntactically valid JSON, schema-invalid: `files_reviewed: []` and no
    // `riskiest_change` at all -- exactly the shape the finding names.
    { model: 'bad/schema', text: JSON.stringify({ verdict: 'clean', files_reviewed: [], findings: [], end: SENTINEL }) },
  ];
  const logged = [];
  const origLog = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  let pooled;
  try {
    pooled = poolFindings(results);
  } finally {
    console.log = origLog;
  }
  assert.equal(pooled.files_reviewed.length, 1, 'the bad model must never source files_reviewed');
  assert.deepEqual(pooled.files_reviewed, [DOCS_PATH]);
  assert.equal(pooled.verdict, 'clean');
  assert.ok(
    logged.some((l) => l.includes('bad/schema') && l.includes('schema validation') && l.includes('SCHEMA_INVALID')),
    'the exclusion must be logged and named by reason',
  );
});

test('finding-6: a pool where ONLY a schema-invalid model answered returns null, same as no parseable answer at all', () => {
  const results = [
    { model: 'bad/schema', text: JSON.stringify({ verdict: 'clean', files_reviewed: [], findings: [], end: SENTINEL }) },
  ];
  assert.equal(poolFindings(results), null);
});

test('finding-7: an all-clean ensemble carries a MERGED class_pass, not an omitted one', () => {
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(cleanDocsAnswer()) },
    { model: 'b/two', text: JSON.stringify(cleanDocsAnswer()) },
  ]);
  assert.equal(pooled.verdict, 'clean');
  assert.ok(Array.isArray(pooled.class_pass), 'class_pass must be carried through, not dropped');
  assert.equal(pooled.class_pass.length, DEFECT_CLASSES.length);
  for (const cls of DEFECT_CLASSES) {
    assert.ok(pooled.class_pass.some((r) => r.class === cls), `${cls} must survive the merge`);
  }
});

test('finding-7: a class only ONE model covers validly is omitted from the merge, not fabricated', () => {
  const complete = cleanDocsAnswer();
  const partial = cleanDocsAnswer();
  // b/two never mentions the first class at all.
  partial.class_pass = partial.class_pass.filter((r) => r.class !== DEFECT_CLASSES[0]);
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(complete) },
    { model: 'b/two', text: JSON.stringify(partial) },
  ]);
  assert.ok(!pooled.class_pass.some((r) => r.class === DEFECT_CLASSES[0]), 'a class not every model passed must not appear');
  assert.equal(pooled.class_pass.length, DEFECT_CLASSES.length - 1);
});

test('finding-7: the merge prefers "clear" over "not-applicable" when models disagree', () => {
  const cls = DEFECT_CLASSES[0];
  const a = cleanDocsAnswer();
  const b = cleanDocsAnswer();
  a.class_pass = a.class_pass.map((r) => (r.class === cls ? { ...r, verdict: 'clear', why: `walked ${cls} at docs/readme.md:2, genuinely clear` } : r));
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(a) },
    { model: 'b/two', text: JSON.stringify(b) },
  ]);
  const row = pooled.class_pass.find((r) => r.class === cls);
  assert.equal(row.verdict, 'clear');
});

// ============================================ finding-5: merged class_pass must survive checkClassPass

test('finding-5: a row with a `why` under MIN_WHY_CHARS is not merge-eligible, even if non-empty', () => {
  const cls = DEFECT_CLASSES[0];
  const shortWhy = cleanDocsAnswer();
  shortWhy.class_pass = shortWhy.class_pass.map((r) => (r.class === cls ? { ...r, why: 'n/a' } : r));
  assert.ok('n/a'.length < MIN_WHY_CHARS, 'fixture precondition: the short why must actually be too short');
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(shortWhy) },
    { model: 'b/two', text: JSON.stringify(cleanDocsAnswer()) },
  ]);
  // Neither model has a MERGE-ELIGIBLE row for `cls` (one is too short, and
  // "every contributing model" must pass), so the class is omitted rather
  // than merged with a row `checkClassPass` would refuse downstream.
  assert.ok(!pooled.class_pass.some((r) => r.class === cls), 'a too-short why must not source a merged row');
});

test('finding-5: two classes given the SAME why by different models get disambiguated, not merged as duplicates', () => {
  const clsA = DEFECT_CLASSES[0];
  const clsB = DEFECT_CLASSES[1];
  const sameWhy = 'this class does not apply to a docs-only diff at all';
  const a = cleanDocsAnswer();
  a.class_pass = a.class_pass.map((r) => (r.class === clsA ? { ...r, why: sameWhy } : r));
  const b = cleanDocsAnswer();
  b.class_pass = b.class_pass.map((r) => (r.class === clsB ? { ...r, why: sameWhy } : r));
  // Every OTHER class must still carry a distinct why so only clsA/clsB collide.
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(a) },
    { model: 'b/two', text: JSON.stringify(b) },
  ]);
  const rowA = pooled.class_pass.find((r) => r.class === clsA);
  const rowB = pooled.class_pass.find((r) => r.class === clsB);
  assert.notEqual(rowA.why.trim().toLowerCase(), rowB.why.trim().toLowerCase(), 'the merge must not ship two identical why values');
  const r = runRealValidator(pooled, DOCS_INPUT);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.doc.classPass, true, 'a merge that disambiguates the collision must satisfy the real checkClassPass');
});

// ------------------------------------------------- finding-8: the REAL validator, end to end

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATE_SCRIPT = join(HERE, 'validate-findings.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'ensemble-pool-validate-'));
let seq = 0;

/** Runs the pooled envelope through the REAL, unmodified validate-findings.mjs CLI. */
function runRealValidator(pooled, input) {
  const n = (seq += 1);
  const rawPath = join(TMP, `raw-${n}.txt`);
  const inputPath = join(TMP, `input-${n}.json`);
  const outPath = join(TMP, `findings-${n}.json`);
  writeFileSync(rawPath, JSON.stringify(pooled));
  writeFileSync(inputPath, JSON.stringify(input));
  const r = spawnSync(process.execPath, [VALIDATE_SCRIPT, '--raw', rawPath, '--input', inputPath, '--out', outPath], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, doc: r.status === 0 ? JSON.parse(readFileSync(outPath, 'utf8')) : null };
}

const DOCS_INPUT = {
  headSha: 'a'.repeat(40),
  files: [{ path: DOCS_PATH, patch: DOCS_PATCH, addedLineRanges: addedLineRanges(DOCS_PATCH) }],
  unreviewable: [],
};

test('finding-8: the pooled envelope for an ALL-CLEAN ensemble passes the real validator', () => {
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(cleanDocsAnswer()) },
    { model: 'b/two', text: JSON.stringify(cleanDocsAnswer()) },
  ]);
  const r = runRealValidator(pooled, DOCS_INPUT);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.doc.verdict, 'clean');
  assert.equal(r.doc.classPass, true, 'the merged class_pass must satisfy checkClassPass, not trip CLASS_PASS_INCOMPLETE');
});

test('finding-8: the pooled envelope for a MIXED ensemble (one clean, one with a real finding) passes the real validator', () => {
  const withFindingDocs = {
    verdict: 'findings',
    files_reviewed: [DOCS_PATH],
    riskiest_change: { path: DOCS_PATH, quoted_line: DOCS_QUOTE },
    findings: [{ path: DOCS_PATH, line: 2, quote: DOCS_QUOTE, body: 'this prose overstates what the code actually does', class: 'description-mismatch' }],
    end: SENTINEL,
  };
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(cleanDocsAnswer()) },
    { model: 'b/two', text: JSON.stringify(withFindingDocs) },
  ]);
  assert.equal(pooled.verdict, 'findings');
  const r = runRealValidator(pooled, DOCS_INPUT);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.doc.verdict, 'findings');
  assert.equal(r.doc.findings.length, 1);
  assert.equal(r.doc.findings[0].source, 'b/two');
});

test('finding-8: a schema-invalid model in the mix never reaches the real validator\'s input at all', () => {
  const badSchema = { verdict: 'clean', files_reviewed: [], findings: [], end: SENTINEL };
  const pooled = poolFindings([
    { model: 'a/one', text: JSON.stringify(cleanDocsAnswer()) },
    { model: 'bad/schema', text: JSON.stringify(badSchema) },
  ]);
  const r = runRealValidator(pooled, DOCS_INPUT);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.doc.verdict, 'clean');
  assert.equal(r.doc.classPass, true);
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
