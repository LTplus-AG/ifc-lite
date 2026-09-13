#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two CLI doors of the no-op `edited` replay (see lib/ci-verdict-replay.mjs
 * for the design and the reasons).
 *
 *   node scripts/ci-verdict-replay.mjs --probe
 *       Run by the `changes` job. Reads the event payload; when it is a
 *       title/body `edited` AND the head SHA already carries a completed
 *       aggregate verdict from an earlier run, writes `noop=true` to
 *       $GITHUB_OUTPUT. Any other event, a retarget, or a head with no verdict
 *       yet writes `noop=false` and the full lane set runs. Exit 0 either way;
 *       an API failure exits 1 (the job goes red rather than guessing).
 *
 *   node scripts/ci-verdict-replay.mjs --replay
 *       Run by the aggregate job when `noop=true`. Finds the same verdict and
 *       REPLAYS it: exit 0 for a recorded `success`, exit 1 for anything else,
 *       exit 2 when nothing is there to replay (the probe found one, so this
 *       means the API moved under us; refuse rather than pass).
 *
 * Inputs come from the Actions environment (GITHUB_EVENT_PATH, GITHUB_EVENT_NAME,
 * GITHUB_REPOSITORY, GITHUB_RUN_ID, GH_TOKEN) or, for tests, from
 * `--event-file <json>` / `--check-runs-file <json>` / `--sha` / `--run-id` /
 * `--repo` / `--output <file>`.
 */

import { readFileSync, appendFileSync } from 'node:fs';

import { gh, GhError } from './lib/gh.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { AGGREGATE_CHECK_NAME, isNoopEdit, selectReplayVerdict } from './lib/ci-verdict-replay.mjs';

function parseArgs(argv) {
  const out = { mode: null, eventFile: process.env.GITHUB_EVENT_PATH ?? null, eventName: process.env.GITHUB_EVENT_NAME ?? null, checkRunsFile: null, sha: null, runId: process.env.GITHUB_RUN_ID ?? null, repo: process.env.GITHUB_REPOSITORY ?? null, output: process.env.GITHUB_OUTPUT ?? null, checkName: AGGREGATE_CHECK_NAME };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--probe' || a === '--replay') out.mode = a.slice(2);
    else if (a === '--event-file') out.eventFile = next();
    else if (a === '--event-name') out.eventName = next();
    else if (a === '--check-runs-file') out.checkRunsFile = next();
    else if (a === '--sha') out.sha = next();
    else if (a === '--run-id') out.runId = next();
    else if (a === '--repo') out.repo = next();
    else if (a === '--output') out.output = next();
    else if (a === '--check') out.checkName = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.mode) throw new Error('one of --probe or --replay is required');
  return out;
}

function readEvent(args) {
  if (!args.eventFile) return { event: null, eventName: args.eventName };
  const event = JSON.parse(readFileSync(args.eventFile, 'utf8'));
  return { event, eventName: args.eventName ?? (event?.pull_request ? 'pull_request' : undefined) };
}

/** `check_runs` for the SHA: every run, not GitHub's default "latest per name". */
function fetchCheckRuns(args, sha) {
  if (args.checkRunsFile) {
    const parsed = JSON.parse(readFileSync(args.checkRunsFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : parsed.check_runs;
  }
  if (!args.repo) throw new Error('GITHUB_REPOSITORY (or --repo) is required to read check runs');
  // `filter=all`, deliberately: the default `latest` keeps ONE run per check
  // name, which on the probe is this very run's in-progress aggregate.
  const page = gh(
    ['api', `repos/${args.repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(args.checkName)}&filter=all&per_page=100`, '--method', 'GET'],
    `the check runs of ${sha.slice(0, 9)}`,
  );
  if (!page || !Array.isArray(page.check_runs)) throw new GhError('GH_BAD_SHAPE', 'check-runs response carried no check_runs array');
  return page.check_runs;
}

function emit(args, key, value) {
  const line = `${key}=${value}\n`;
  if (args.output) appendFileSync(args.output, line);
  console.log(`  ${key}=${value}`);
}

export function run(argv) {
  const args = parseArgs(argv);
  const { event, eventName } = readEvent(args);
  const sha = args.sha ?? event?.pull_request?.head?.sha ?? null;

  if (args.mode === 'probe') {
    if (!isNoopEdit(event, eventName)) {
      console.log(`[verdict-replay] ${eventName ?? 'unknown event'}${event?.action ? ` (${event.action})` : ''}: not a no-op edit; the full lane set runs.`);
      emit(args, 'noop', 'false');
      return 0;
    }
    if (!sha) throw new Error('a no-op edit event with no pull_request.head.sha cannot be probed');
    const verdict = selectReplayVerdict(fetchCheckRuns(args, sha), { sha, checkName: args.checkName, excludeRunId: args.runId });
    if (!verdict.found) {
      console.log(`[verdict-replay] title/body edit of ${sha.slice(0, 9)}, but ${verdict.reason}; the full lane set runs.`);
      emit(args, 'noop', 'false');
      return 0;
    }
    console.log(
      `[verdict-replay] title/body edit of ${sha.slice(0, 9)}: a completed "${args.checkName}" verdict already exists ` +
        `(${verdict.conclusion}, run ${verdict.runId ?? '?'}, ${verdict.completedAt}). Every lane skips; the aggregate replays it.`,
    );
    emit(args, 'noop', 'true');
    return 0;
  }

  // --replay
  if (!sha) throw new Error('--replay needs the head SHA (from the event payload or --sha)');
  const verdict = selectReplayVerdict(fetchCheckRuns(args, sha), { sha, checkName: args.checkName, excludeRunId: args.runId });
  if (!verdict.found) {
    console.error(`[verdict-replay] REFUSING: asked to replay a verdict for ${sha.slice(0, 9)} but ${verdict.reason}. Re-run the workflow for a full verdict.`);
    return 2;
  }
  console.log(
    `[verdict-replay] replaying "${args.checkName}" = ${verdict.conclusion} from run ${verdict.runId ?? '?'} (${verdict.completedAt})${verdict.url ? `: ${verdict.url}` : ''}`,
  );
  if (verdict.success) {
    console.log('  ✔ the head already had a green verdict; this title/body edit changes nothing a test could see.');
    return 0;
  }
  console.error(`  ✘ the head's recorded verdict is "${verdict.conclusion}"; a title/body edit does not clear it. Push a fix or re-run the earlier run.`);
  return 1;
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`[verdict-replay] ${err instanceof GhError ? err.reason : 'ERROR'}: ${err.message}`);
    process.exitCode = 1;
  }
}
