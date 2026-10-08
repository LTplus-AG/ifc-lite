#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live AI evaluation runner (#6928). Opt-in, never run by CI, never given a
 * credential by this repository. It exercises the Assistant's REAL request
 * (system prompt with frozen evidence) against configured providers with
 * fixed settings and a root budget, and keeps unreviewed results in the
 * gitignored `tests/ai-eval/results/<run>/`.
 *
 *   IFCLITE_AI_EVAL_LIVE=1 \
 *   IFCLITE_AI_EVAL_OPENAI_URL=<OpenAI-compatible chat completions URL> \
 *   IFCLITE_AI_EVAL_OPENAI_MODEL=<model id> OPENAI_API_KEY=<key> \
 *     node scripts/ai-eval/run-live-eval.mjs --providers openai [--tasks a,b] [--repeats 1]
 *
 * Providers: `proxy` (the viewer's hosted free-model proxy, no credential;
 * set IFCLITE_AI_EVAL_PROXY_URL and _MODEL), `anthropic`, `openai`. A provider
 * without its environment is skipped with the reason, not faked.
 * `--requests <file>` reuses a prior `pnpm ai-eval requests` capture; `--out <dir>` overrides the
 * results folder; `--dry-run` prints the plan and sends nothing. After a run:
 *   (cd apps/viewer && pnpm ai-eval review --recordings <run>/recordings --out <run>/review.json)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProvider, runLive } from './lib/live.mjs';
import { REPO_ROOT } from './lib/recording.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };

function capture(manifestPath, model, tasks, out) {
  const only = tasks ? ['--tasks', tasks.join(',')] : [];
  const result = spawnSync('pnpm', ['--dir', join(REPO_ROOT, 'apps', 'viewer'), 'ai-eval', 'requests', '--manifest', manifestPath, '--model', model, '--out', out, ...only],
    { stdio: ['ignore', 'inherit', 'inherit'], cwd: REPO_ROOT, env: { ...process.env, INIT_CWD: REPO_ROOT } });
  if (result.status !== 0) throw new Error('Capturing the Assistant requests failed (run pnpm install first)');
}

export async function main(args, env) {
  if (env.IFCLITE_AI_EVAL_LIVE !== '1') {
    console.error('Live evaluation is opt-in: set IFCLITE_AI_EVAL_LIVE=1 and the provider variables (see the header of this file). Nothing was sent.');
    return 2;
  }
  const manifestPath = join(REPO_ROOT, 'tests', 'ai-eval', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const wanted = (flag(args, 'providers') ?? '').split(',').filter(Boolean);
  if (!wanted.length) throw new Error('--providers proxy,anthropic,openai (any subset) is required');
  const providers = [];
  for (const name of wanted) {
    const entry = manifest.liveEvaluation.providers.find(provider => provider.kind === name);
    if (!entry) throw new Error(`Unknown provider ${name}`);
    const resolved = resolveProvider(entry, env);
    if (resolved.reason) console.error(`skipping ${name}: ${resolved.reason}`); else providers.push(resolved);
  }
  if (!providers.length) return 2;
  const tasks = flag(args, 'tasks')?.split(',') ?? manifest.tasks.map(task => task.id);
  const repeats = Number(flag(args, 'repeats') ?? 1);
  const runId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase();
  const runDir = flag(args, 'out') ? resolve(flag(args, 'out')) : join(REPO_ROOT, 'tests', 'ai-eval', 'results', runId);
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ runId, providers: providers.map(({ kind, model, url }) => ({ kind, model, url })), tasks, repeats, budget: manifest.liveEvaluation.budget }, null, 2));
    return 0;
  }
  mkdirSync(join(runDir, 'recordings'), { recursive: true });
  const requestsFile = flag(args, 'requests') ? resolve(flag(args, 'requests')) : join(runDir, 'requests.json');
  if (!flag(args, 'requests')) capture(manifestPath, providers[0].model, tasks, requestsFile);
  const outcome = await runLive({ manifest, captured: JSON.parse(readFileSync(requestsFile, 'utf8')), providers, tasks, repeats, fetchImpl: fetch, runId });
  for (const recording of outcome.recordings) writeFileSync(join(runDir, 'recordings', `${recording.id}.json`), `${JSON.stringify(recording, null, 2)}\n`);
  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify({ runId, settings: outcome.settings, run: outcome.run, stopped: outcome.stopped, receipts: outcome.receipts, results: outcome.results }, null, 2)}\n`);
  console.log(`${outcome.receipts.length} request(s); ${outcome.run.reportedOutputTokens} reported output tokens; ${outcome.run.unreported} without reported usage.${outcome.stopped ? ` Stopped: ${outcome.stopped}.` : ''}`);
  const flagged = outcome.results.filter(result => result.violations?.length);
  console.log(`${flagged.length} answer(s) with invariant violations. Results: ${runDir}`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(code => { process.exitCode = code; },
    error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
