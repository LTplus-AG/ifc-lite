/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fetch the open PR list for the dirty-PR scan in pieces small enough to
 * finish (#5729).
 *
 * WHY NOT ONE `gh pr list`. The scan used to ask for every open PR's
 * `statusCheckRollup` in one GraphQL query. At 40+ check contexts per PR,
 * that query outgrew GitHub's gateway timeout: `main` went red on
 * `HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)`, run after
 * run. A 504 is the gateway giving up on one expensive query, so the fix is to
 * stop sending it:
 *
 *   1. a cheap list of open PR NUMBERS (no rollup);
 *   2. the heavy fields PER PR, via `gh pr view`, a few at a time. Each
 *      answer has the same JSON shape `gh pr list --json` gave, because both
 *      commands use gh's own field mapping, so `scanPrs` sees identical rows.
 *
 * Each call retries a transient 5xx with backoff. THE CONTRACT DOES NOT MOVE:
 * a call that still fails after its retries throws, and the scan exits 2
 * ("could not look"), never an empty list read as "no PRs". A PR that closes
 * between steps 1 and 2 is no longer open, so the scan has nothing to say
 * about it: step 2 also reads `state` and drops anything not OPEN, and a PR
 * `gh` can no longer resolve at all is skipped. No other error is skipped.
 */

import { spawn } from 'node:child_process';

/** Heavy fields, fetched per PR. `baseRefName` is load-bearing: see `classifyPr`. */
export const PR_FIELDS = 'number,title,url,baseRefName,mergeable,mergeStateStatus,isDraft,statusCheckRollup';

/** A transient server-side failure worth another try: 5xx and gateway timeouts, nothing else. */
const TRANSIENT_RE = /\bHTTP 5\d\d\b|Gateway Time-?out|Bad Gateway|Service Unavailable/i;

/** A PR that closed (or was deleted) between the number list and its own fetch. */
const GONE_RE = /Could not resolve to a PullRequest/i;

/**
 * Run `gh` once, asynchronously, so several per-PR fetches can overlap.
 *
 * @param {string[]} args
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string, error?: Error }>}
 */
export function spawnGh(args) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: null, stdout, stderr, error });
      return;
    }
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * One `gh` JSON call with bounded retries on a transient 5xx.
 *
 * @param {object} o
 * @param {string[]} o.args
 * @param {string} o.what - names the fetch in messages.
 * @param {(reason: string, message: string) => Error} o.fail - the caller's error factory.
 * @param {typeof spawnGh} [o.run]
 * @param {number[]} [o.backoffMs] - one entry per retry.
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {(line: string) => void} [o.log]
 * @param {RegExp} [o.tolerate] - stderr that means "answer null" instead of failing.
 */
export async function ghJsonWithRetry({
  args,
  what,
  fail,
  run = spawnGh,
  backoffMs = [2000, 5000, 10000],
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (line) => console.error(line),
  tolerate = null,
}) {
  for (let attempt = 0; ; attempt += 1) {
    const r = await run(args);
    if (r.error) {
      throw fail('GH_UNAVAILABLE', `Could not spawn \`gh\` to fetch ${what}: ${r.error.message}.`);
    }
    if (r.status === 0) {
      try {
        return JSON.parse(r.stdout);
      } catch (err) {
        throw fail('GH_BAD_JSON', `\`gh ${args.join(' ')}\` returned unparseable output while fetching ${what}: ${err.message}`);
      }
    }
    const stderr = (r.stderr || '').trim();
    if (tolerate && tolerate.test(stderr)) return null;
    if (TRANSIENT_RE.test(stderr) && attempt < backoffMs.length) {
      log(`dirty-pr-scan: ${what}: transient failure (${stderr.split('\n')[0]}); retry ${attempt + 1}/${backoffMs.length} in ${backoffMs[attempt]}ms.`);
      await sleep(backoffMs[attempt]);
      continue;
    }
    throw fail(
      'GH_ERROR',
      `\`gh ${args.join(' ')}\` exited ${r.status} while fetching ${what}` +
        (attempt > 0 ? ` (after ${attempt} retr${attempt === 1 ? 'y' : 'ies'})` : '') +
        `: ${stderr || '(no stderr)'}`,
    );
  }
}

/**
 * The open PRs, each in `gh pr list --json PR_FIELDS` shape, in list order.
 *
 * @param {object} o
 * @param {string} o.repo
 * @param {number} o.limit - most PRs to scan, as `--limit` always meant.
 * @param {(reason: string, message: string) => Error} o.fail
 * @param {number} [o.concurrency]
 * @param {Omit<Parameters<typeof ghJsonWithRetry>[0], 'args' | 'what' | 'fail'>} [o.ghOptions]
 */
export async function fetchOpenPrs({ repo, limit, fail, concurrency = 6, ghOptions = {} }) {
  const listed = await ghJsonWithRetry({
    ...ghOptions,
    args: ['pr', 'list', '--state', 'open', '--json', 'number', '--limit', String(limit), '--repo', repo],
    what: 'the open PR numbers',
    fail,
  });
  if (!Array.isArray(listed)) {
    throw fail('GH_BAD_JSON', `The open PR number list was not an array: ${JSON.stringify(listed).slice(0, 200)}.`);
  }
  const numbers = listed.map((p) => p?.number);
  if (!numbers.every((n) => Number.isInteger(n) && n > 0)) {
    throw fail('GH_BAD_JSON', `The open PR number list carried a non-number: ${JSON.stringify(listed).slice(0, 200)}.`);
  }

  const out = new Array(numbers.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= numbers.length) return;
      out[i] = await ghJsonWithRetry({
        ...ghOptions,
        args: ['pr', 'view', String(numbers[i]), '--json', `${PR_FIELDS},state`, '--repo', repo],
        what: `PR #${numbers[i]}`,
        fail,
        tolerate: GONE_RE,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, numbers.length)) }, worker));
  // Same order `gh pr list` returned, and the same row shape: `state` was only
  // asked for to drop PRs that closed in between.
  return out.filter((pr) => pr !== null && pr.state === 'OPEN').map(({ state: _state, ...pr }) => pr);
}
