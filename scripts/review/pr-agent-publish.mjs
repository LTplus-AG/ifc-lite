#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publish one PR-Agent lane's review, or fail with a named reason.
 *
 * .github/workflows/pr-agent-review.yml runs PR-Agent in plain-diff mode
 * (scripts/review/pr-agent-run.sh), so PR-Agent never holds a GitHub token and
 * this file owns the only write.
 *
 * WHY THE EXIT CODE OF PR-AGENT IS NOT EVIDENCE. Measured against 0.45.0: an
 * OpenRouter 401, a missing key and a 429 "no credits remaining" all exit 0.
 * PR-Agent logs the error, writes "Failed to review PR" to `--output`, and
 * writes no `--json-output` at all. So the review happened if and only if
 * review.json parses and holds a non-empty `review` object. Everything else is
 * a failure, labelled from the log when the log says why.
 *
 * WHY THE BODY IS DEFANGED. This comment is posted as `github-actions`, which
 * scripts/review-posted.config.json trusts to write the Claude lane's
 * `ifc-lite-review` marker. A model steered by the diff could emit that marker
 * and satisfy `Review posted` for a head nobody reviewed. `defangDangerous` is
 * the Claude lane's own sanitiser, imported rather than copied.
 *
 * ONE COMMENT PER LANE, found by the marker on its first line and by author.
 * A failed run rewrites that comment to say the head was NOT reviewed. Runs
 * that never reach this script (nothing reviewable, local endpoint unavailable)
 * leave an earlier review in place; its heading names the commit it reviewed.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { gh } from '../lib/gh.mjs';
import { normaliseLogin, pageAll } from '../check-review-posted.mjs';
import { defangDangerous } from './lib/finding-sanitizers.mjs';

export class PrAgentPublishError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const LANES = { openrouter: 'OpenRouter', local: 'local model' };
/** GitHub rejects an issue comment over 65,536 characters. */
const MAX_REVIEW_CHARS = 60_000;

export const laneMarker = (lane) => `<!-- ifc-lite-pr-agent lane=${lane} -->`;

/**
 * [reason, pattern over PR-Agent's error lines, remedy], most specific first.
 * The last three have no pattern: they are decided by which files exist.
 */
const FAILURES = [
  ['CREDITS_EXHAUSTED', /\b402\b|insufficient[_ ]credits|no credits|payment required/i,
    'The provider reports no credits left (for OpenRouter, top up the account), then re-run.'],
  ['AUTH_FAILED', /AuthenticationError|\b401\b|invalid[_ ]api[_ ]key|user not found/i,
    'The endpoint rejected the key: check OPENROUTER_API_KEY, or PR_AGENT_LOCAL_API_KEY for the local lane.'],
  ['RATE_LIMITED', /RateLimitError|\b429\b|rate.?limit/i, 'The provider throttled the request. Re-run later.'],
  ['CONTEXT_TOO_LONG', /ContextWindowExceeded|context length|maximum context/i,
    'Lower PR_AGENT_OPENROUTER_MAX_MODEL_TOKENS or PR_AGENT_LOCAL_MAX_MODEL_TOKENS so PR-Agent clips the diff.'],
  ['ENDPOINT_UNREACHABLE', /APIConnectionError|connection refused|ConnectError|timed? ?out/i,
    'The model endpoint did not answer. Check it is running and reachable from the runner.'],
  ['NO_REVIEW', null, 'The log of the step that ran PR-Agent has the details, including a timeout.'],
  ['NO_OUTPUT', null, "PR-Agent left no output at all, so the run step did not finish. Read that job's log."],
  ['BAD_OUTPUT', null, 'PR-Agent wrote output this script cannot read. The log of the step that ran PR-Agent has the details.'],
];
const remedy = (reason) => FAILURES.find(([r]) => r === reason)[2];

/**
 * PR-Agent's log prefix, `2026-09-13 13:46:43.401 | ERROR    | module:function:1201 - `.
 * Its milliseconds and line number would otherwise read as a status code.
 */
const LOG_PREFIX_RE = /^[^|]*\|[^|]*\|\s*\S+ - /;

/**
 * Reads only the message of error lines, so a token count ("Tokens: 401") is
 * not taken for a status code either.
 *
 * @param {string|null} logText
 */
export function classifyFailure(logText) {
  const errorLines = stripVTControlCharacters(String(logText ?? ''))
    .split('\n')
    .filter((line) => /error|exception|failed/i.test(line))
    .map((line) => line.replace(LOG_PREFIX_RE, ''))
    .join('\n');
  return FAILURES.find(([, re]) => re?.test(errorLines))?.[0] ?? 'NO_REVIEW';
}

const fail = (reason, what) => new PrAgentPublishError(reason, `${what} ${remedy(reason)}`);

/**
 * @param {{ jsonText: string|null, markdownText: string|null, logText: string|null }} files
 * @returns {{ markdown: string, usage: object }}
 */
export function readOutcome({ jsonText, markdownText, logText }) {
  if (jsonText === null) {
    throw fail(logText === null ? 'NO_OUTPUT' : classifyFailure(logText), 'PR-Agent wrote no review.json.');
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw fail('BAD_OUTPUT', `review.json did not parse: ${err.message}.`);
  }
  const review = parsed?.review;
  if (review === null || typeof review !== 'object' || Array.isArray(review) || Object.keys(review).length === 0) {
    throw fail('BAD_OUTPUT', 'review.json holds no review object.');
  }
  const markdown = String(markdownText ?? '').trim();
  if (markdown === '' || /^Failed to review/i.test(markdown)) {
    throw fail('BAD_OUTPUT', 'review.md is empty or reports a failure.');
  }
  return { markdown, usage: parsed.usage ?? {} };
}

export function reviewBody({ lane, sha, markdown }) {
  let text = defangDangerous(markdown);
  if (text.length > MAX_REVIEW_CHARS) text = `${text.slice(0, MAX_REVIEW_CHARS)}\n\n[truncated]`;
  return [
    laneMarker(lane),
    `### PR-Agent review (${LANES[lane]}) at \`${sha.slice(0, 9)}\``,
    '',
    text,
    '',
    '<sub>Advisory. Produced by PR-Agent from the diff alone; it gates nothing and does not replace the Claude review lane.</sub>',
  ].join('\n');
}

function notReviewedBody({ lane, sha, error }) {
  return [
    laneMarker(lane),
    `### PR-Agent review (${LANES[lane]}): NOT reviewed at \`${sha.slice(0, 9)}\``,
    '',
    `The review of this head did not complete: \`${error.reason}\`. ${defangDangerous(error.message)}`,
    '',
    'Whatever this comment said before was about an older commit and has been removed.',
  ].join('\n');
}

/**
 * The default transport: `gh api`, which throws on every failure. The body goes
 * through a file because a 60,000-character argument can exceed the per-argument
 * limit on Linux.
 */
function ghApi(method, path, body) {
  const args = ['api', path, '--method', method];
  if (body !== undefined) {
    const file = join(mkdtempSync(join(tmpdir(), 'pr-agent-body-')), 'body.md');
    writeFileSync(file, body);
    args.push('-F', `body=@${file}`);
  }
  return gh(args, `${method} ${path}`, PrAgentPublishError);
}

function findLaneComment({ api, repo, pr, lane }) {
  const { rows, truncated } = pageAll((page, perPage) =>
    api('GET', `repos/${repo}/issues/${pr}/comments?per_page=${perPage}&page=${page}`),
  );
  if (truncated) {
    throw new PrAgentPublishError('COMMENTS_TRUNCATED', 'Could not read every PR comment, so the lane comment may exist unseen.');
  }
  return rows.find((c) => normaliseLogin(c?.user?.login) === 'github-actions' && String(c.body ?? '').startsWith(laneMarker(lane))) ?? null;
}

const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

export function publish({ lane, dir, repo, pr, sha, api = ghApi }) {
  if (!LANES[lane]) throw new PrAgentPublishError('BAD_ARGS', `Unknown lane \`${lane}\`.`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new PrAgentPublishError('BAD_ARGS', '`--sha` must be a 40-hex commit.');
  let outcome = null;
  let error = null;
  try {
    outcome = readOutcome({
      jsonText: readIfPresent(join(dir, 'review.json')),
      markdownText: readIfPresent(join(dir, 'review.md')),
      logText: readIfPresent(join(dir, 'pr-agent.log')),
    });
  } catch (err) {
    if (!(err instanceof PrAgentPublishError)) throw err;
    error = err;
  }

  const existing = findLaneComment({ api, repo, pr, lane });
  // A failure with no earlier comment posts nothing: the red check says it.
  if (error && !existing) throw error;
  const body = error ? notReviewedBody({ lane, sha, error }) : reviewBody({ lane, sha, markdown: outcome.markdown });
  const written = existing
    ? api('PATCH', `repos/${repo}/issues/comments/${existing.id}`, body)
    : api('POST', `repos/${repo}/issues/${pr}/comments`, body);
  if (!written?.id || !String(written.body ?? '').startsWith(laneMarker(lane))) {
    throw new PrAgentPublishError('POST_UNCONFIRMED', 'GitHub did not return the comment that was written.');
  }
  if (error) throw error;
  return { url: written.html_url, usage: outcome.usage };
}

if (isMainEntry(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(['lane', 'dir', 'repo', 'pr', 'sha'].map((k) => [k, { type: 'string' }])),
    });
    for (const k of ['lane', 'dir', 'repo', 'pr', 'sha']) {
      if (!values[k]) throw new PrAgentPublishError('BAD_ARGS', `Pass \`--${k}\`.`);
    }
    const { url, usage } = publish(values);
    console.log(`pr-agent: review posted at ${url}; usage ${JSON.stringify(usage)}`);
  } catch (err) {
    if (!(err instanceof PrAgentPublishError)) throw err;
    console.error(`❌ ${err.reason}: ${err.message}`);
    console.error(`::error::PR-Agent review not published: ${err.reason}`);
    process.exit(1);
  }
}
