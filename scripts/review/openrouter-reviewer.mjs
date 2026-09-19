#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { redactSecrets } from './lib/redact-secrets.mjs';

/**
 * A CHAIN, not a single model. OpenRouter fronts many providers behind one
 * key, so a model-specific outage (rate limit, deprecation, a provider's own
 * downtime) does not have to take the whole fallback down with it: the next
 * model in the list is tried before giving up. All three are verified present
 * on OpenRouter's /models list at the time this was written.
 */
export const OPENROUTER_REVIEW_MODELS_DEFAULT = ['anthropic/claude-sonnet-5', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-luna'];
// gpt-5.4-nano FIRST: the cheapest model in the pricing table
// (ensemble-reviewer.mjs's MODEL_PRICES_PER_MTOK) that the judge -- a
// keep/drop-only, no-tools, one-turn pass over already-validated findings --
// needs no more capability than. Haiku stays as the failover.
export const OPENROUTER_JUDGE_MODELS_DEFAULT = ['openai/gpt-5.4-nano', 'anthropic/claude-haiku-4.5'];

/** Kept as a plain single-model constant: the first of the review chain. */
export const OPENROUTER_REVIEW_MODEL = OPENROUTER_REVIEW_MODELS_DEFAULT[0];

/**
 * NO TIMEOUT WAS THE BUG. A `fetch` with no `signal` waits as long as the
 * remote end (or a dead TCP connection) lets it, which on GitHub Actions is
 * the job's own 20-minute ceiling -- and this call sits inside the Claude
 * failover loop, so one stalled OpenRouter request did not just fail slowly,
 * it blocked every OTHER credential and provider behind it from ever being
 * tried. `resolveTimeoutMs` is exported so `provider-fallbacks.mjs` can
 * compute the SAME value it hands to `runOpenRouterFallback`'s spawnSync
 * budget below, and callers keep their own default: the reviewer waits longer
 * per model (it is the primary path) than the judge (an optional filter that
 * must fail soft quickly, not sit on the job's clock).
 */
export const OPENROUTER_TIMEOUT_MS_DEFAULT = 300_000;

/** @param {unknown} raw `OPENROUTER_TIMEOUT_MS`, or any other override value. */
export function resolveTimeoutMs(raw, fallback = OPENROUTER_TIMEOUT_MS_DEFAULT) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Extract the model's text, whether it comes back as a string or an array of parts. */
export function responseText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
  }
  return '';
}

/**
 * The one call site that actually hits the network. Returns `usage` alongside
 * `text` because the parallel ensemble (ensemble-reviewer.mjs) needs OpenRouter's
 * own token counts to print a per-run cost hint; `requestOpenRouterReview` below
 * is the pre-existing, text-only contract every other caller and test already
 * depends on, so it stays a thin wrapper rather than changing shape.
 */
export async function requestOpenRouterReviewWithUsage({
  prompt, apiKey, model = OPENROUTER_REVIEW_MODEL, fetchImpl = fetch, timeoutMs = OPENROUTER_TIMEOUT_MS_DEFAULT,
}) {
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://github.com/LTplus-AG/ifc-lite',
      'X-Title': 'ifc-lite review lane',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 32768,
      reasoning: { effort: 'high' },
    }),
    // A per-model failure, not a hang: `requestOpenRouterReviewChain` below
    // already treats ANY thrown error here (HTTP, network, this abort) as
    // "this model failed, try the next one", so timing out needs no new catch
    // path -- it just needs to fire before the chain's caller's own timeout
    // (the failover loop, ultimately the job) does.
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = null; }
  if (!response.ok) {
    // Redacted before it ever reaches an Error message: this string is logged
    // verbatim (see requestOpenRouterReviewChain and runOpenRouterFallback's
    // stderr forwarding), which lands in the public Actions log. OpenRouter is
    // not expected to echo the Authorization header back in an error body, but
    // this is the backstop for the day some upstream provider does.
    const detail = redactSecrets(String(parsed?.error?.message ?? body ?? '(empty)').slice(0, 2000));
    throw new Error(`OpenRouter chat completions API returned HTTP ${response.status}: ${detail}`);
  }
  const text = responseText(parsed?.choices?.[0]?.message);
  if (!text) throw new Error('OpenRouter response completed without output text.');
  return { text, usage: parsed?.usage ?? null };
}

export async function requestOpenRouterReview(opts) {
  const { text } = await requestOpenRouterReviewWithUsage(opts);
  return text;
}

/**
 * Split a comma-separated model list. Returns `[]` (not the caller's default)
 * on empty input, so a caller can tell "nothing configured" from "configured
 * to one model" and choose its own fallback -- see `resolveModelChain`.
 */
export function parseModelChain(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return [];
  return trimmed.split(',').map((m) => m.trim()).filter(Boolean);
}

/**
 * The plural env var wins when set; the singular one is accepted as an
 * override that becomes a one-element chain, so an existing
 * `OPENROUTER_REVIEW_MODEL` (or `OPENROUTER_JUDGE_MODEL`) setting keeps
 * working unchanged rather than being silently ignored once the chain
 * shipped.
 */
export function resolveModelChain({ modelsRaw, modelRaw, defaults }) {
  const plural = parseModelChain(modelsRaw);
  if (plural.length > 0) return plural;
  const single = String(modelRaw ?? '').trim();
  if (single) return [single];
  return defaults;
}

/**
 * Try each model in order. A model-level failure -- HTTP error, empty
 * content, anything `requestOpenRouterReview` throws -- logs and moves to the
 * next one; only exhausting the whole chain is a hard failure. Returns which
 * model actually answered, because the caller (`runReviewerWithFailover`)
 * reports it in the posted envelope rather than leaving "which model" a
 * mystery on a run that used the third choice.
 */
export async function requestOpenRouterReviewChain({ prompt, apiKey, models, fetchImpl = fetch, timeoutMs = OPENROUTER_TIMEOUT_MS_DEFAULT }) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('No OpenRouter model configured.');
  }
  const failures = [];
  for (const [i, model] of models.entries()) {
    try {
      const text = await requestOpenRouterReview({ prompt, apiKey, model, fetchImpl, timeoutMs });
      return { text, model };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const next = models[i + 1] ?? '(no more models)';
      console.error(`provider openrouter: ${model} failed: ${message}; trying ${next}`);
      failures.push(`${model}: ${message}`);
    }
  }
  throw new Error(`Every OpenRouter model failed:\n${failures.join('\n')}`);
}

/**
 * Run async fetch in an isolated child while the Claude CLI path stays
 * synchronous. The chosen model cannot travel back to the parent through
 * stdout -- that channel is the review text itself -- so it rides a single
 * `MODEL_USED:` line on stderr instead, which the parent strips out below.
 *
 * EVERY OTHER STDERR LINE IS FORWARDED TO THE PARENT LOG, unconditionally, on
 * both success and failure. `requestOpenRouterReviewChain` inside the child
 * already logs each model's own failure with `console.error` -- that is where
 * "provider openrouter: anthropic/claude-sonnet-5 failed: ..." was written --
 * but it stayed trapped in `result.stderr`, which this function used to read
 * only for the `MODEL_USED` line and otherwise discard. A run that failed over
 * from the first chain model to the second therefore printed only "succeeded
 * (model=...)" with no trace of why the first one was skipped (PR #4981, run
 * 35424837640). Forwarding here, not filtering to failures only, means a
 * partial chain success is diagnosable from the parent job log alone.
 */
export function runOpenRouterFallback({
  prompt, apiKey, models = OPENROUTER_REVIEW_MODELS_DEFAULT, spawn = spawnSync, timeoutMs = OPENROUTER_TIMEOUT_MS_DEFAULT,
}) {
  // The PARENT-SIDE backstop. `timeoutMs` bounds each model's fetch INSIDE the
  // child (via `AbortSignal.timeout`, wired through the env below and read by
  // the child's own main-entry block), but the chain tries every model in
  // `models` sequentially, so the child's own worst case is `timeoutMs *
  // models.length`. Without a `spawnSync` `timeout` of at least that, a child
  // that hangs for a reason the abort signal cannot see -- stuck DNS, a
  // runaway event-loop task after the response, anything below `fetch` -- still
  // blocks this synchronous call, and with it every credential and provider
  // still queued behind it, for as long as the runner's job timeout allows.
  const childTimeoutMs = timeoutMs * Math.max(models.length, 1) + 30_000;
  const result = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: childTimeoutMs,
    env: { ...process.env, OPENROUTER_API_KEY: apiKey, OPENROUTER_REVIEW_MODELS: models.join(','), OPENROUTER_TIMEOUT_MS: String(timeoutMs) },
  });
  if (result.error) throw new Error(`Could not spawn OpenRouter fallback: ${result.error.message}`);
  if (result.signal) {
    throw new Error(`OpenRouter fallback was killed by signal ${result.signal} after exceeding its ${childTimeoutMs}ms budget.`);
  }
  const stderr = String(result.stderr ?? '');
  for (const line of stderr.split('\n')) {
    if (line && !/^MODEL_USED:/.test(line)) console.log(`openrouter-fallback (child): ${line}`);
  }
  if (result.status !== 0) {
    throw new Error(`OpenRouter fallback exited ${result.status}: ${stderr.trim() || '(empty)'}`);
  }
  const text = String(result.stdout ?? '').trim();
  if (!text) throw new Error('OpenRouter fallback exited 0 without output text.');
  const modelUsed = stderr.match(/^MODEL_USED:(\S+)$/m)?.[1];
  return { text, model: modelUsed };
}

if (isMainEntry(import.meta.url)) {
  try {
    const apiKey = String(process.env.OPENROUTER_API_KEY ?? '').trim();
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing.');
    const models = resolveModelChain({
      modelsRaw: process.env.OPENROUTER_REVIEW_MODELS,
      modelRaw: process.env.OPENROUTER_REVIEW_MODEL,
      defaults: OPENROUTER_REVIEW_MODELS_DEFAULT,
    });
    const timeoutMs = resolveTimeoutMs(process.env.OPENROUTER_TIMEOUT_MS);
    const { text, model } = await requestOpenRouterReviewChain({ prompt: readFileSync(0, 'utf8'), apiKey, models, timeoutMs });
    process.stderr.write(`MODEL_USED:${model}\n`);
    process.stdout.write(text);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
