#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A PARALLEL CHEAP ENSEMBLE, not a stronger failover chain.
 *
 * `openrouter-reviewer.mjs`'s chain tries one model, then the next, only on
 * failure -- it spends one model's worth of tokens per PR and reaches for a
 * second only when the first is down. At ~950 reviews/week that one-model-at-
 * a-time chain is cheap, but it is also one opinion: a single cheap model
 * missing a defect class is not caught by a chain that never asks a second
 * model the same question.
 *
 * This module asks several CHEAP models the SAME prompt, concurrently, and
 * pools their findings before the existing mechanical validator and judge ever
 * see them. Strong models (Sonnet, `openai/gpt-5.6-sol`) stay reserved for the
 * failover path in run-reviewer.mjs, which only fires when this ensemble is
 * disabled, unconfigured, or fails outright.
 *
 * COST, not correctness, is why this exists. Prices below are USD per million
 * tokens, hardcoded from OpenRouter's published rates at the time this was
 * written -- never fetched live, because a review lane must not grow a network
 * dependency on a pricing API just to print a log line. A run's own `usage`
 * field (prompt_tokens/completion_tokens) is what `estimateCostUsd` actually
 * multiplies; the table only supplies the per-token rate.
 *
 * POOLING IS AT THE FINDINGS LEVEL, not by concatenating raw text. Each
 * model's JSON is parsed independently and its `findings` array is tagged with
 * `source: <model>` before merging, so a duplicate defect flagged by two models
 * survives as two findings for the judge to deduplicate (see judge.md and
 * run-judge.mjs's prompt change) rather than being silently dropped here. The
 * MERGED result is re-serialised as ONE combined raw-review JSON, because the
 * pipeline downstream of run-reviewer.mjs (validate-findings.mjs, the retry
 * step, the judge) all expect a single raw-text envelope; this is the "combined
 * raw text whose sections the validator accepts" shape called for when
 * per-model validation cannot travel independently through that pipeline.
 *
 * CLEAN IS UNANIMOUS. The pooled verdict is `clean` only when every model that
 * produced a parseable answer said `clean`; ANY successful model reporting
 * findings makes the pooled verdict `findings`, because a miss by the majority
 * is still a real defect if even one cheap model caught it.
 */

import { writeFileSync } from 'node:fs';
import { requestOpenRouterReviewWithUsage, parseModelChain } from './openrouter-reviewer.mjs';
import { stripFence } from './validate-findings.mjs';
// `checkSchema` is the REAL validator's own top-level shape check (SCHEMA_INVALID/
// FINDINGS_INVALID/VERDICT_CONTRADICTS_FINDINGS), reused rather than duplicated: see
// `poolFindings` below for why a syntactically-valid-but-schema-invalid model answer
// must never source the pooled envelope's metadata.
import { SENTINEL, checkSchema } from './lib/finding-schema.mjs';
import { ValidateFindingsError } from './lib/validate-findings-error.mjs';
import { mergeClassPass } from './lib/merge-class-pass.mjs';
import { classify as classifyPrRisk } from './classify-pr-risk.mjs';

/** Reference chain for docs/PR description only -- see `resolveEnsembleModels` for why this is NOT a runtime fallback. */
export const REVIEW_ENSEMBLE_MODELS_DEFAULT = [
  'openai/gpt-5.6-luna',
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4-flash',
];

/** Added to the ensemble only under `REVIEW_ENSEMBLE_STRONG_ON_RISK` on a high-risk PR. */
export const REVIEW_ENSEMBLE_STRONG_MODEL = 'openai/gpt-5.6-sol';

/**
 * USD per MILLION tokens, { in, out }. A cost TABLE, not a cost CALL: see the
 * module docblock for why this is never fetched. Extend this table, never
 * invent a price for a model absent from it -- `estimateCostUsd` returns `null`
 * rather than guess.
 */
export const MODEL_PRICES_PER_MTOK = {
  'openai/gpt-5.6-luna': { in: 0.20, out: 1.20 },
  'deepseek/deepseek-v4.1-flash': { in: 0.15, out: 0.60 },
  'deepseek/deepseek-v4-flash': { in: 0.05, out: 0.09 },
  'openai/gpt-5.4-nano': { in: 0.20, out: 1.25 },
  'anthropic/claude-haiku-4.5': { in: 1.00, out: 5.00 },
  'anthropic/claude-sonnet-5': { in: 2.00, out: 10.00 },
  'openai/gpt-5.6-sol': { in: 2.00, out: 10.00 },
};

/** @returns {number|null} USD, or null when the model or the usage field is unknown. */
export function estimateCostUsd(model, usage) {
  const price = MODEL_PRICES_PER_MTOK[model];
  if (!price || !usage) return null;
  const promptTok = Number(usage.prompt_tokens ?? 0);
  const completionTok = Number(usage.completion_tokens ?? 0);
  return (promptTok / 1e6) * price.in + (completionTok / 1e6) * price.out;
}

/**
 * `REVIEW_ENSEMBLE_MODELS` unset or empty means the ensemble is OFF: this
 * returns `[]`, never `REVIEW_ENSEMBLE_MODELS_DEFAULT`. Unlike
 * `resolveModelChain`'s failover chain, an absent ensemble var is not "use the
 * default cheap models" -- it is "run the existing single-model/failover path
 * unchanged", so a repository that never sets this var sees no behaviour
 * change at all. The default list is what the PR description recommends
 * setting the repo variable to, not a code-level fallback.
 */
export function resolveEnsembleModels(env) {
  return parseModelChain(env.REVIEW_ENSEMBLE_MODELS);
}

/** A tiny concurrency gate: at most `limit` of `tasks` run at once. */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fire every model at the SAME prompt, concurrently, each an independent
 * OpenRouter request -- no CLI, no tool, no shell, the same "pure function"
 * shape run-reviewer.mjs requires of every model call. One model's HTTP
 * failure never blocks another's: `Promise.allSettled` semantics via
 * `runWithConcurrency`, so a run with 3 models and 1 timeout still returns 2
 * usable results.
 *
 * @returns {Promise<{results: {model: string, text: string, usage: object|null, elapsedMs: number}[], failures: {model: string, error: string}[]}>}
 */
export async function runEnsemble({ prompt, apiKey, models, minSuccess = 1, concurrency, fetchImpl = fetch }) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('runEnsemble requires at least one model.');
  }
  const tasks = models.map((model) => async () => {
    const startedAt = Date.now();
    try {
      const { text, usage } = await requestOpenRouterReviewWithUsage({ prompt, apiKey, model, fetchImpl });
      const elapsedMs = Date.now() - startedAt;
      const cost = estimateCostUsd(model, usage);
      console.log(
        `ensemble: ${model} answered in ${elapsedMs}ms, ${text.length} chars` +
          (cost !== null ? `, ~$${cost.toFixed(4)}` : ''),
      );
      return { ok: true, model, text, usage: usage ?? null, elapsedMs };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`ensemble: ${model} failed after ${elapsedMs}ms: ${message}`);
      return { ok: false, model, error: message };
    }
  });
  const outcomes = await runWithConcurrency(tasks, concurrency ?? models.length);
  const results = outcomes.filter((o) => o.ok).map(({ ok: _ok, ...rest }) => rest);
  const failures = outcomes.filter((o) => !o.ok).map(({ model, error }) => ({ model, error }));
  if (results.length < minSuccess) {
    console.log(`ensemble: only ${results.length}/${models.length} model(s) succeeded, below minSuccess=${minSuccess}.`);
  }
  return { results, failures };
}

/**
 * Parse every model's JSON answer, KEEP ONLY THE SCHEMA-VALID ONES, tag each
 * survivor's findings with `source`, and pool into ONE combined raw-review
 * envelope. Returns `null` when nothing usable survives, so the caller can
 * fall through to the CLI/failover chain exactly as if the ensemble had never
 * run.
 *
 * SCHEMA VALIDATION HAPPENS HERE, not only downstream in `validate-findings.mjs`,
 * because a syntactically valid but SCHEMA-invalid answer (`files_reviewed: []`,
 * a missing `riskiest_change`, `findings` not an array, a `clean` verdict with
 * findings attached) used to become the metadata SOURCE below purely by being
 * `parsed[0]` -- one badly-shaped cheap model corrupted every other model's
 * otherwise-good pooled result. `checkSchema` is the real validator's own
 * top-level check, reused rather than duplicated, so "what counts as
 * schema-valid" cannot drift between this file and the one that enforces it for
 * real.
 *
 * `files_reviewed` and `riskiest_change` are taken from the FIRST model whose
 * answer is schema-valid -- every model was sent the identical roster and
 * prompt, so a compliant answer names the same set regardless of which one
 * supplies it, and mechanical validation downstream still checks that set
 * against the diff we actually sent, not against anything asserted here.
 */
export function poolFindings(results, expectedFiles = null) {
  const parsed = [];
  const expected = Array.isArray(expectedFiles) ? new Set(expectedFiles) : null;
  for (const r of results) {
    let obj;
    try {
      obj = JSON.parse(stripFence(r.text).trim());
    } catch (error) {
      console.log(`ensemble: ${r.model} answer was not parseable JSON: ${error.message}`);
      continue;
    }
    // THE TERMINAL SENTINEL IS CHECKED HERE TOO, not left to the real
    // validator downstream. `poolFindings` re-serialises a SINGLE combined
    // envelope with its OWN `end: SENTINEL` (below), so a per-model response
    // missing the sentinel -- or carrying the wrong one -- would otherwise be
    // silently repaired into a valid-looking one before the validator's own
    // RESPONSE_TRUNCATED check ever saw it. That is the exact "stopped early
    // yet still parses" shape `finding-schema.mjs`'s SENTINEL comment warns
    // about, just laundered through this file instead. A model whose answer
    // fails this check is excluded from the pool the same way a schema-invalid
    // one is: logged, and counted as a per-model failure, not silently patched.
    if (obj?.end !== SENTINEL) {
      console.log(
        `ensemble: ${r.model} answer has no valid terminal sentinel (RESPONSE_TRUNCATED-shaped); excluded from the pool.`,
      );
      continue;
    }
    try {
      checkSchema(obj);
    } catch (error) {
      // ANY OF checkSchema'S THREE FATAL REASONS (SCHEMA_INVALID,
      // FINDINGS_INVALID, VERDICT_CONTRADICTS_FINDINGS) DISQUALIFIES this
      // model from the pool, the same way it would disqualify a single-model
      // run: a model that emits `verdict: "clean"` alongside findings, or
      // omits `riskiest_change`, is not a source of truth for anything else
      // it said either.
      const reason = error instanceof ValidateFindingsError ? error.reason : 'UNKNOWN';
      console.log(`ensemble: ${r.model} answer failed schema validation (${reason}): ${error.message}`);
      continue;
    }
    // PER-MODEL PROOF OF WORK, when the caller knows the roster it sent. The
    // pooled envelope takes ONE model's `files_reviewed`; if that model stopped
    // early its roster would fail the real validator's PROOF_OF_WORK_FAILED and
    // discard the whole pool, even though another model listed every file.
    if (expected) {
      const claimed = new Set(Array.isArray(obj.files_reviewed) ? obj.files_reviewed : []);
      const mismatch = [...expected].some((f) => !claimed.has(f)) || [...claimed].some((f) => !expected.has(f));
      if (mismatch) {
        console.log(`ensemble: ${r.model} files_reviewed is not the set that was sent (PROOF_OF_WORK-shaped); excluded from the pool.`);
        continue;
      }
    }
    // A CLEAN VERDICT WITHOUT A CLASS PASS IS AN INCOMPLETE REVIEW, and the
    // validator's CLASS_PASS_INCOMPLETE would reject it alone. Pooled with a
    // complete one it would be laundered into a posted clean, so it is
    // excluded here instead of silently dropped by mergeClassPass.
    if (obj.verdict === 'clean' && !Array.isArray(obj.class_pass)) {
      console.log(`ensemble: ${r.model} said clean without a class_pass (CLASS_PASS_INCOMPLETE-shaped); excluded from the pool.`);
      continue;
    }
    parsed.push({ model: r.model, obj });
  }
  if (parsed.length === 0) return null;

  const findings = [];
  for (const { model, obj } of parsed) {
    if (Array.isArray(obj?.findings)) {
      for (const f of obj.findings) {
        if (f && typeof f === 'object' && !Array.isArray(f)) findings.push({ ...f, source: model });
      }
    }
  }
  // THE POOLED VERDICT FOLLOWS THE MERGED FINDINGS. A model that reported a
  // finding is not outvoted by two that reported clean, because its finding is
  // in the merged list; a model that said `findings` with an empty array
  // contributes nothing and must not turn an otherwise clean pool into a
  // `findings` envelope with no findings (VALIDATION_EMPTY downstream).
  const first = parsed[0].obj ?? {};
  const classPass = mergeClassPass(parsed);
  return {
    verdict: findings.length > 0 ? 'findings' : 'clean',
    files_reviewed: Array.isArray(first.files_reviewed) ? first.files_reviewed : [],
    riskiest_change: first.riskiest_change ?? null,
    findings,
    // OMITTED, not written as `undefined`, when no contributing model supplied
    // one: `JSON.stringify` drops an `undefined`-valued key on its own, but
    // being explicit here is what `mergeClassPass`'s own doc comment promises.
    ...(classPass !== undefined ? { class_pass: classPass } : {}),
    end: SENTINEL,
  };
}

/**
 * The one entry point run-reviewer.mjs calls. Runs the ensemble, pools, and
 * hands back either usable pooled TEXT (ready for the same `--out` file the
 * CLI path writes) or `null` to signal "fall through unchanged".
 *
 * @returns {Promise<{text: string, models: string[], failed: {model: string, error: string}[]} | null>}
 */
export async function runEnsembleReview({ prompt, apiKey, models, minSuccess = 1, concurrency, fetchImpl = fetch, expectedFiles = null }) {
  const { results, failures } = await runEnsemble({ prompt, apiKey, models, minSuccess, concurrency, fetchImpl });
  if (results.length < minSuccess) return null;
  const pooled = poolFindings(results, expectedFiles);
  if (!pooled) return null;
  return {
    text: JSON.stringify(pooled),
    models: results.map((r) => r.model),
    failed: failures,
  };
}

/**
 * Which models to ask, or `null` if the ensemble should not run at all. Pure
 * and synchronous: the only inputs are the env and the file list already
 * sitting in review-input.json, never a fresh `gh` call. That is what makes
 * design item 5 (add the strong model on a high-risk PR) CHEAP rather than a
 * second API round trip -- `classify-pr-risk.mjs`'s `classify()` is a pure
 * function over paths, and the paths are already in `input.files`.
 *
 * A live `low-risk` PR LABEL was considered and rejected: `pr-risk-label.yml`
 * is a separate, unordered workflow triggered by the same `pull_request`
 * event, with no guarantee it has run (or the label has propagated) before
 * this step reads it. Treating "label absent" as "high risk" during that race
 * would add the strong model to nearly every PR, defeating the cost target
 * this ensemble exists for.
 */
export function resolveEnsemblePlan(env, input) {
  const models = resolveEnsembleModels(env);
  if (models.length === 0) return null;
  const apiKey = String(env.OPENROUTER_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const withStrong = [...models];
  if (String(env.REVIEW_ENSEMBLE_STRONG_ON_RISK ?? '').trim() === 'true') {
    const paths = [
      ...(input.files ?? []).map((f) => f.path),
      ...(input.unreviewable ?? []).map((u) => u.path),
    ];
    const risk = classifyPrRisk(paths);
    if (!risk.lowRisk && !withStrong.includes(REVIEW_ENSEMBLE_STRONG_MODEL)) {
      console.log(`ensemble: high-risk PR (${risk.why}); adding ${REVIEW_ENSEMBLE_STRONG_MODEL}.`);
      withStrong.push(REVIEW_ENSEMBLE_STRONG_MODEL);
    }
  }
  return { models: withStrong, apiKey };
}

/**
 * The one entry point run-reviewer.mjs calls from `main()`. Writes `outPath`
 * and returns `true` when the ensemble produced a usable pooled answer, so
 * the caller can skip the CLI/failover chain entirely; returns `false` to mean
 * "do nothing, fall through unchanged" -- disabled, unconfigured, or every
 * model failed.
 */
export async function maybeRunEnsemble({ env, input, prompt, outPath }) {
  const plan = resolveEnsemblePlan(env, input);
  if (!plan) return false;
  console.log(`ensemble: asking ${plan.models.join(', ')} in parallel.`);
  // `input.files` here is the raw review-input.json array (path objects), the
  // same roster `checkProofOfWork` later compares against.
  const expectedFiles = Array.isArray(input?.files) ? input.files.map((f) => f.path) : null;
  const outcome = await runEnsembleReview({ prompt, apiKey: plan.apiKey, models: plan.models, minSuccess: 1, expectedFiles });
  if (!outcome) {
    console.log('ensemble: no model produced a usable answer; falling through to the CLI/failover chain.');
    return false;
  }
  writeFileSync(outPath, outcome.text);
  // provider: 'openrouter-ensemble' -- the same envelope shape
  // `runReviewerWithFailover` returns for a single-provider fallback, named
  // here for a reader grepping logs for how a review was produced.
  const envelope = { provider: 'openrouter-ensemble', models: outcome.models, failed: outcome.failed };
  console.log(
    `ensemble: pooled ${envelope.models.length}/${plan.models.length} model(s) (${envelope.models.join(', ')})` +
      (envelope.failed.length > 0 ? `; failed: ${envelope.failed.map((f) => f.model).join(', ')}` : '') +
      `; ${outcome.text.length} chars written. The CLI and its failover chain were not invoked.`,
  );
  return true;
}
