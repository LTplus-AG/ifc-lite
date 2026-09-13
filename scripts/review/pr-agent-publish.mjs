#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publish one PR-Agent lane's review, or fail with a named reason.
 *
 * .github/workflows/pr-agent-review.yml runs PR-Agent in plain-diff mode
 * (`--diff-file ... --output review.md --json-output review.json review`), so
 * PR-Agent never holds a GitHub token and this file owns the only write.
 *
 * WHY THE EXIT CODE OF PR-AGENT IS NOT EVIDENCE. Measured against 0.45.0: an
 * OpenRouter 401 and a 429 "no credits remaining" both exit 0. PR-Agent logs
 * the error, writes "Failed to review PR" to `--output`, and writes no
 * `--json-output` at all. So the review happened if and only if review.json
 * parses and holds a non-empty `review` object. Everything else is a failure,
 * labelled from the log when the log says why.
 *
 * WHY THE BODY IS DEFANGED. This comment is posted as `github-actions`, which
 * scripts/review-posted.config.json trusts to write the Claude lane's
 * `ifc-lite-review` marker. A model steered by the diff could emit that marker
 * and satisfy `Review posted` for a head nobody reviewed. `defangDangerous` is
 * the Claude lane's own sanitiser, imported rather than copied.
 *
 * ONE COMMENT PER LANE, found by the marker on its first line and by author.
 * A failed run rewrites that comment to say the head was NOT reviewed, so a
 * review of an older commit never sits under a newer head looking current.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { gh } from '../lib/gh.mjs';
import { pageAll } from '../check-review-posted.mjs';
import { defangDangerous } from './lib/finding-sanitizers.mjs';

export class PrAgentPublishError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

export const LANES = { openrouter: 'OpenRouter', local: 'local model' };
const BOT_LOGIN = 'github-actions[bot]';
/** GitHub rejects an issue comment over 65,536 characters. */
const MAX_REVIEW_CHARS = 60_000;

export const laneMarker = (lane) => `<!-- ifc-lite-pr-agent lane=${lane} -->`;

/**
 * Most specific first. Only error lines are read, so a token count such as
 * "Tokens: 401" can never be mistaken for a status code.
 */
const FAILURE_CLASSES = [
  ['CREDITS_EXHAUSTED', /\b402\b|insufficient[_ ]credits|no credits|payment required/i],
  ['AUTH_FAILED', /AuthenticationError|\b401\b|invalid[_ ]api[_ ]key|user not found|API_KEY is not set/i],
  ['RATE_LIMITED', /RateLimitError|\b429\b|rate.?limit/i],
  ['CONTEXT_TOO_LONG', /ContextWindowExceeded|context length|maximum context/i],
  ['ENDPOINT_UNREACHABLE', /APIConnectionError|connection refused|ConnectError|timed? ?out/i],
];

export const REMEDY = {
  CREDITS_EXHAUSTED: 'Top up the OpenRouter account, then re-run the job.',
  AUTH_FAILED: 'Check the OPENROUTER_API_KEY secret (or the local endpoint key), then re-run.',
  RATE_LIMITED: 'The provider throttled the request. Re-run later.',
  CONTEXT_TOO_LONG: 'Lower this lane\'s max-model-tokens variable (PR_AGENT_OPENROUTER_MAX_MODEL_TOKENS or PR_AGENT_LOCAL_MAX_MODEL_TOKENS) so PR-Agent clips the diff.',
  ENDPOINT_UNREACHABLE: 'The model endpoint did not answer. Check it is running and reachable from the runner.',
  NO_REVIEW: 'Read pr-agent.log in the job output.',
  NO_OUTPUT: 'PR-Agent left no output at all, so the run step did not finish. Read that job\'s log.',
  BAD_OUTPUT: 'PR-Agent wrote output this script cannot read. Read pr-agent.log in the job output.',
};

/** @param {string} logText */
export function classifyFailure(logText) {
  const errorLines = String(logText ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((line) => /error|exception|failed/i.test(line))
    .join('\n');
  for (const [reason, re] of FAILURE_CLASSES) {
    if (re.test(errorLines)) return reason;
  }
  return 'NO_REVIEW';
}

/**
 * @param {{ jsonText: string|null, markdownText: string|null, logText: string|null }} files
 * @returns {{ markdown: string, usage: object }}
 */
export function readOutcome({ jsonText, markdownText, logText }) {
  if (jsonText === null) {
    const reason = logText === null ? 'NO_OUTPUT' : classifyFailure(logText);
    throw new PrAgentPublishError(reason, `PR-Agent wrote no review.json. ${REMEDY[reason]}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new PrAgentPublishError('BAD_OUTPUT', `review.json did not parse: ${err.message}. ${REMEDY.BAD_OUTPUT}`);
  }
  const review = parsed?.review;
  if (review === null || typeof review !== 'object' || Array.isArray(review) || Object.keys(review).length === 0) {
    throw new PrAgentPublishError('BAD_OUTPUT', `review.json holds no review object. ${REMEDY.BAD_OUTPUT}`);
  }
  const markdown = String(markdownText ?? '').trim();
  if (markdown === '' || /^Failed to review/i.test(markdown)) {
    throw new PrAgentPublishError('BAD_OUTPUT', `review.md is empty or reports a failure. ${REMEDY.BAD_OUTPUT}`);
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

export function notReviewedBody({ lane, sha, reason, message }) {
  return [
    laneMarker(lane),
    `### PR-Agent review (${LANES[lane]}): NOT reviewed at \`${sha.slice(0, 9)}\``,
    '',
    `The review of this head did not complete: \`${reason}\`. ${defangDangerous(message)}`,
    '',
    'Whatever this comment said before was about an older commit and has been removed.',
  ].join('\n');
}

/** The default transport: `gh api`, which throws on every failure. */
export function ghApi(method, path, body) {
  const args = ['api', path, '--method', method];
  if (body !== undefined) {
    const file = join(mkdtempSync(join(tmpdir(), 'pr-agent-body-')), 'body.md');
    writeFileSync(file, body);
    args.push('-F', `body=@${file}`);
  }
  return gh(args, `${method} ${path}`, PrAgentPublishError);
}

export function findLaneComment({ api, repo, pr, lane }) {
  const { rows, truncated } = pageAll((page, perPage) =>
    api('GET', `repos/${repo}/issues/${pr}/comments?per_page=${perPage}&page=${page}`),
  );
  if (truncated) {
    throw new PrAgentPublishError('COMMENTS_TRUNCATED', 'Could not read every PR comment, so the lane comment may exist unseen.');
  }
  return rows.find((c) => c?.user?.login === BOT_LOGIN && String(c.body ?? '').startsWith(laneMarker(lane))) ?? null;
}

/** Create or update the lane comment and check the response carries it back. */
export function upsertLaneComment({ api, repo, pr, lane, body }) {
  const existing = findLaneComment({ api, repo, pr, lane });
  const written = existing
    ? api('PATCH', `repos/${repo}/issues/comments/${existing.id}`, body)
    : api('POST', `repos/${repo}/issues/${pr}/comments`, body);
  if (!written?.id || !String(written.body ?? '').startsWith(laneMarker(lane))) {
    throw new PrAgentPublishError('POST_UNCONFIRMED', 'GitHub did not return the comment that was written.');
  }
  return written;
}

const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

export function publish({ lane, dir, repo, pr, sha, api = ghApi }) {
  if (!LANES[lane]) throw new PrAgentPublishError('BAD_ARGS', `Unknown lane \`${lane}\`.`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new PrAgentPublishError('BAD_ARGS', '`--sha` must be a 40-hex commit.');
  let outcome;
  try {
    outcome = readOutcome({
      jsonText: readIfPresent(join(dir, 'review.json')),
      markdownText: readIfPresent(join(dir, 'review.md')),
      logText: readIfPresent(join(dir, 'pr-agent.log')),
    });
  } catch (err) {
    if (!(err instanceof PrAgentPublishError)) throw err;
    const existing = findLaneComment({ api, repo, pr, lane });
    if (existing) {
      api('PATCH', `repos/${repo}/issues/comments/${existing.id}`, notReviewedBody({ lane, sha, reason: err.reason, message: err.message }));
    }
    throw err;
  }
  const written = upsertLaneComment({ api, repo, pr, lane, body: reviewBody({ lane, sha, markdown: outcome.markdown }) });
  return { url: written.html_url, usage: outcome.usage };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!['lane', 'dir', 'repo', 'pr', 'sha'].includes(key) || argv[i + 1] === undefined) {
      throw new PrAgentPublishError('BAD_ARGS', `Unrecognised or valueless argument \`${argv[i]}\`.`);
    }
    out[key] = argv[i + 1];
  }
  for (const k of ['lane', 'dir', 'repo', 'pr', 'sha']) {
    if (!out[k]) throw new PrAgentPublishError('BAD_ARGS', `Pass \`--${k}\`.`);
  }
  return out;
}

if (isMainEntry(import.meta.url)) {
  try {
    const { url, usage } = publish(parseArgs(process.argv.slice(2)));
    console.log(`pr-agent: review posted at ${url}; usage ${JSON.stringify(usage)}`);
  } catch (err) {
    if (!(err instanceof PrAgentPublishError)) throw err;
    console.error(`❌ ${err.reason}: ${err.message}`);
    console.error(`::error::PR-Agent review not published: ${err.reason}`);
    process.exit(1);
  }
}
