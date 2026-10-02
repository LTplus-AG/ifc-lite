#!/usr/bin/env node
/* SPDX-License-Identifier: MPL-2.0 */
// A single-model adapter for rubric-eval. No ensemble pooling or failover can
// silently attribute another model's findings to the candidate being measured.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildPrompt } from './run-reviewer.mjs';
import { requestOpenRouterReviewWithUsage } from './openrouter-reviewer.mjs';
import { estimateCostUsd, MODEL_PRICES_PER_MTOK } from './lib/review-cost.mjs';
import { appendTelemetry } from './lib/review-telemetry.mjs';

export function reserveCost(model, prompt, maxTokens, spent, budget) {
  const price = MODEL_PRICES_PER_MTOK[model];
  if (!price || !Number.isFinite(budget) || budget <= 0) throw new Error('Known model pricing and a positive finite budget are required.');
  // UTF-8 bytes bound input tokens conservatively; reasoning shares max_tokens.
  const reserve = (Buffer.byteLength(prompt) * price.in + maxTokens * price.out) / 1e6;
  if (spent + reserve > budget) throw new Error(`Evaluation budget exhausted: spent $${spent.toFixed(4)}, next reservation $${reserve.toFixed(4)}, budget $${budget}.`);
  return reserve;
}

async function main() {
  const flags = new Set(['--rubric', '--input', '--out', '--model', '--retry-note', '--retry-reason']);
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    if (!flags.has(argv[i]) || !argv[i + 1]) throw new Error(`Invalid argument: ${argv[i]}`);
    args[argv[i]] = argv[i + 1];
  }
  for (const flag of ['--rubric', '--input', '--out', '--model']) if (!args[flag]) throw new Error(`Missing ${flag}`);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is missing.');
  const input = JSON.parse(readFileSync(args['--input'], 'utf8'));
  const prompt = buildPrompt(readFileSync(args['--rubric'], 'utf8'), input, {
    retryNote: args['--retry-note'] ? readFileSync(args['--retry-note'], 'utf8') : null,
    retryReason: args['--retry-reason'] ?? 'PROOF_OF_WORK_FAILED',
  });
  const ledger = process.env.EVAL_COST_LEDGER;
  if (!ledger) throw new Error('EVAL_COST_LEDGER is required for the spending limit.');
  const spent = existsSync(ledger) ? Number(readFileSync(ledger, 'utf8')) : 0;
  if (!Number.isFinite(spent) || spent < 0) throw new Error('Invalid cost ledger.');
  const budget = Number(process.env.EVAL_BUDGET_USD ?? 3);
  const maxTokens = 32768;
  const model = args['--model'];
  const reserve = reserveCost(model, prompt, maxTokens, spent, budget);
  // Reserve before requesting: an interrupted/failed call may still be billed.
  writeFileSync(ledger, String(spent + reserve));
  const startedAt = Date.now();
  const result = await requestOpenRouterReviewWithUsage({ prompt, apiKey, model, maxTokens });
  const costUsd = estimateCostUsd(model, result.usage);
  // If usage is absent, keep the reservation rather than treating it as free.
  const charged = costUsd ?? reserve;
  writeFileSync(ledger, String(spent + charged));
  appendTelemetry(`${args['--out']}.telemetry.jsonl`, {
    model, pr: input.pr, elapsedMs: Date.now() - startedAt,
    maxTokens, usage: result.usage, costUsd: charged,
    costSource: typeof result.usage?.cost === 'number' ? 'billed' : costUsd === null ? 'reserved' : 'estimated',
  });
  writeFileSync(args['--out'], result.text);
}

if (process.argv[1]?.endsWith('openrouter-eval-reviewer.mjs')) main().catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
