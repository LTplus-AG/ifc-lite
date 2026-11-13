#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Contributor License Agreement gate for pull requests.
 *
 * Every human who opens a pull request, or authors a commit in it, must have
 * signed the CLA in CLA.md. A person signs by commenting the sign phrase on a
 * pull request; the signature is appended to a JSON record on the
 * `cla-signatures` branch, and the gate reports a `CLA` commit status. The
 * decisions live in lib/cla-policy.mjs; this file is the GitHub I/O.
 *
 * Runs from `pull_request_target` and `issue_comment`, so it holds write
 * tokens. It reads PR metadata through the API only and never checks out or
 * executes pull-request code; the workflow checks out the default branch.
 *
 * Why not CLA Assistant Lite: its repository was archived in March 2026, and
 * running unmaintained third-party code with `contents: write` on fork pull
 * requests is the exact risk this job must not take.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import {
  CLA_VERSION,
  ClaGateError,
  SIGNATURE_BRANCH,
  SIGNATURE_PATH,
  STATUS_CONTEXT,
  COMMENT_MARKER,
  addSignature,
  claFingerprint,
  commentBody,
  decideEvent,
  evaluate,
  validateRecord,
} from './lib/cla-policy.mjs';

export * from './lib/cla-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Same buffer as lib/gh.mjs, whose invoker this does not reuse because the gate
 * needs three things it lacks: request bodies on stdin, the HTTP status of a
 * failure (404 means "no record yet", 409 means "retry"), and an injectable
 * spawn for tests. Truncated output must never read as a short answer.
 */
const MAX_BUFFER = 128 * 1024 * 1024;

function makeGh(spawn) {
  return function gh(args, input) {
    const res = spawn('gh', ['api', ...args], {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: MAX_BUFFER,
      input: input === undefined ? undefined : JSON.stringify(input),
    });
    if (res.error) throw new ClaGateError('GH_FAILED', res.error.message);
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  };
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ClaGateError('GH_FAILED', `${what}: the API returned non-JSON: ${error.message}`);
  }
}

function ghJson(gh, args, input) {
  const res = gh(args, input);
  if (res.status !== 0) {
    throw new ClaGateError('GH_FAILED', `gh api ${args.join(' ')}: ${res.stderr.trim() || `exit ${res.status}`}`);
  }
  return res.stdout.trim() ? parseJson(res.stdout, args[args.length - 1]) : null;
}

/**
 * Read the record at the branch head COMMIT, not the branch name: a read by
 * name can be served from cache and return the blob from before the last
 * write, which would make every retry after a conflict hit the same stale sha.
 * `head` is null when the branch does not exist yet.
 */
export function readRecord(gh, repo) {
  const ref = gh([`repos/${repo}/git/ref/heads/${SIGNATURE_BRANCH}`]);
  if (ref.status !== 0) {
    if (/HTTP 404/.test(ref.stderr)) return { record: validateRecord(null), sha: null, head: null };
    throw new ClaGateError('GH_FAILED', `Could not read ${SIGNATURE_BRANCH}: ${ref.stderr.trim()}`);
  }
  const head = parseJson(ref.stdout, SIGNATURE_BRANCH)?.object?.sha;
  if (typeof head !== 'string') throw new ClaGateError('GH_FAILED', `${SIGNATURE_BRANCH} has no head commit.`);
  const res = gh([`repos/${repo}/contents/${SIGNATURE_PATH}?ref=${head}`]);
  if (res.status !== 0) {
    if (/HTTP 404/.test(res.stderr)) return { record: validateRecord(null), sha: null, head };
    throw new ClaGateError('GH_FAILED', `Could not read signatures: ${res.stderr.trim()}`);
  }
  const file = parseJson(res.stdout, SIGNATURE_PATH);
  // The contents API leaves `content` empty for files over 1 MB; the blob API serves up to 100 MB.
  const base64 = file.encoding === 'base64' ? file.content : ghJson(gh, [`repos/${repo}/git/blobs/${file.sha}`]).content;
  let record;
  try {
    record = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch (error) {
    throw new ClaGateError('BAD_RECORD', `${SIGNATURE_PATH} on ${SIGNATURE_BRANCH} is not valid JSON: ${error.message}`);
  }
  return { record: validateRecord(record), sha: file.sha, head };
}

/** Write the record. A missing branch is created as an orphan holding only the signatures. */
export function writeRecord(gh, repo, { record, sha, head }, message) {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (head === null) {
    const tree = ghJson(gh, ['--method', 'POST', `repos/${repo}/git/trees`, '--input', '-'], {
      tree: [{ path: SIGNATURE_PATH, mode: '100644', type: 'blob', content: text }],
    });
    const commit = ghJson(gh, ['--method', 'POST', `repos/${repo}/git/commits`, '--input', '-'], {
      message, tree: tree.sha, parents: [],
    });
    const res = gh(['--method', 'POST', `repos/${repo}/git/refs`, '--input', '-'], {
      ref: `refs/heads/${SIGNATURE_BRANCH}`, sha: commit.sha,
    });
    if (res.status === 0) return 'created';
    if (/HTTP 422/.test(res.stderr)) return 'conflict'; // created concurrently; retry as an update
    throw new ClaGateError('GH_FAILED', `Could not create ${SIGNATURE_BRANCH}: ${res.stderr.trim()}`);
  }
  const body = { message, branch: SIGNATURE_BRANCH, content: Buffer.from(text).toString('base64') };
  if (sha) body.sha = sha;
  const res = gh(['--method', 'PUT', `repos/${repo}/contents/${SIGNATURE_PATH}`, '--input', '-'], body);
  if (res.status === 0) return 'updated';
  // Only a stale sha is a race worth retrying. A repository rule also answers
  // 409/422, and retrying that would bury the real cause behind "try again".
  if (/HTTP 409|HTTP 422/.test(res.stderr) && !/rule/i.test(res.stderr) && /sha|does not match|expected/i.test(res.stderr)) return 'conflict';
  throw new ClaGateError('GH_FAILED', `Could not write signatures: ${res.stderr.trim()}`);
}

/** Append a signature, retrying on concurrent writes. Returns the record as written. */
export function recordSignature(gh, repo, args, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const current = readRecord(gh, repo);
    const { record: next, added } = addSignature(current.record, args);
    if (!added) return { outcome: 'already-signed', record: next };
    const outcome = writeRecord(gh, repo, { ...current, record: next }, `Record CLA v${CLA_VERSION} signature of @${args.signer.login} (#${args.number})`);
    if (outcome !== 'conflict') return { outcome, record: next };
  }
  throw new ClaGateError('WRITE_CONFLICT', 'The signature record kept changing during the write. Post the sign phrase again.');
}

/** Post the comment when there is something to fix; afterwards only ever update it, never add another. */
function syncComment(gh, repo, number, result, body) {
  const comments = ghJson(gh, ['--paginate', '--slurp', `repos/${repo}/issues/${number}/comments?per_page=100`]).flat();
  const mine = comments.find((c) => c?.user?.login === 'github-actions[bot]' && c.body?.startsWith(COMMENT_MARKER));
  if (mine) {
    if (mine.body !== body) ghJson(gh, ['--method', 'PATCH', `repos/${repo}/issues/comments/${mine.id}`, '--input', '-'], { body });
    return;
  }
  if (result.state === 'failure') ghJson(gh, ['--method', 'POST', `repos/${repo}/issues/${number}/comments`, '--input', '-'], { body });
}

function checkPullRequest(gh, repo, number, record, claUrl) {
  const pr = ghJson(gh, [`repos/${repo}/pulls/${number}`]);
  if (pr.state !== 'open') return null;
  const commits = ghJson(gh, ['--paginate', '--slurp', `repos/${repo}/pulls/${number}/commits?per_page=100`]).flat();
  let result = evaluate(pr, commits, record);
  if (result.state === 'failure') {
    // Runs are not ordered against each other: a run that read the record
    // before a concurrent signature could post a stale red over its green.
    // Re-read just before posting a failure to keep that window small; a
    // `recheck` comment fixes anything that still slips through.
    const fresh = readRecord(gh, repo).record;
    // Union with the record passed in: in a sign run that is the record just
    // written, which a cached re-read may not show yet.
    result = evaluate(pr, commits, {
      ...fresh,
      signatures: [...record.signatures, ...fresh.signatures],
      offline: [...record.offline, ...fresh.offline],
    });
  }
  ghJson(gh, ['--method', 'POST', `repos/${repo}/statuses/${pr.head.sha}`, '--input', '-'], {
    state: result.state,
    context: STATUS_CONTEXT,
    description: result.description,
    target_url: claUrl,
  });
  if (!result.exemptPr) {
    // The status is what gates the merge; a comment that cannot be written
    // (a locked conversation, say) must not fail the run after it is set.
    try {
      syncComment(gh, repo, number, result, commentBody(result, claUrl, `https://github.com/${repo}/blob/main/docs/contributing/cla.md`));
    } catch (error) {
      if (!(error instanceof ClaGateError)) throw error;
      console.warn(`WARN: could not update the CLA comment on #${number}: ${error.message}`);
    }
  }
  return result;
}

/**
 * A signature covers every open pull request of the signer, not just the one
 * it was posted on. Search finds the PRs they opened; a PR where they only
 * authored commits turns green on its next push or a `recheck` comment.
 */
function otherOpenPullRequests(gh, repo, login, except) {
  const q = encodeURIComponent(`repo:${repo} is:pr is:open author:${login}`);
  const found = ghJson(gh, [`search/issues?q=${q}&per_page=100`]);
  return (found?.items ?? []).map((i) => i.number).filter((n) => n !== except);
}

export function run({ eventName, payload, repo, claText, claCommit, spawn = spawnSync }) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new ClaGateError('BAD_REPO', `Invalid GITHUB_REPOSITORY ${JSON.stringify(repo)}.`);
  }
  const decision = decideEvent(eventName, payload);
  if (decision.action === 'ignore') return { decision };
  if (typeof claCommit !== 'string' || !/^[0-9a-f]{40}$/.test(claCommit)) {
    throw new ClaGateError('BAD_COMMIT', `CLA_COMMIT must be a full commit SHA, got ${JSON.stringify(claCommit)}.`);
  }
  const gh = makeGh(spawn);
  const claSha256 = claFingerprint(claText);
  const claUrl = `https://github.com/${repo}/blob/${claCommit}/CLA.md`;

  if (decision.action === 'evaluate') {
    return { decision, result: checkPullRequest(gh, repo, decision.number, readRecord(gh, repo).record, claUrl), alsoChecked: [] };
  }

  // A failure on one pull request must not stop the others from being
  // rechecked; the first error is rethrown at the end.
  let firstError = null;
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof ClaGateError)) throw error;
      console.warn(`WARN: ${error.message}`);
      firstError ??= error;
      return null;
    }
  };
  if (decision.action === 'backfill') {
    const record = readRecord(gh, repo).record;
    const open = ghJson(gh, ['--paginate', '--slurp', `repos/${repo}/pulls?state=open&per_page=100`]).flat();
    const alsoChecked = open.map((p) => p.number).filter((n) => attempt(() => checkPullRequest(gh, repo, n, record, claUrl)));
    if (firstError) throw firstError;
    return { decision, result: null, alsoChecked };
  }

  // Evaluate against the record just written: an immediate re-read can return the cached old blob.
  const { outcome: signed, record } = recordSignature(gh, repo, { ...decision, claSha256, claCommit });
  const result = attempt(() => checkPullRequest(gh, repo, decision.number, record, claUrl));
  const alsoChecked = [];
  for (const n of attempt(() => otherOpenPullRequests(gh, repo, decision.signer.login, decision.number)) ?? []) {
    if (attempt(() => checkPullRequest(gh, repo, n, record, claUrl))) alsoChecked.push(n);
  }
  if (firstError) throw firstError;
  return { decision, signed, result, alsoChecked };
}

function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new ClaGateError('BAD_EVENT', 'GITHUB_EVENT_PATH is unset.');
  let payload;
  try {
    payload = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch (error) {
    throw new ClaGateError('BAD_EVENT', `Could not read the webhook payload at ${eventPath}: ${error.message}`);
  }
  const out = run({
    eventName: process.env.GITHUB_EVENT_NAME,
    payload,
    repo: process.env.GITHUB_REPOSITORY,
    claText: readFileSync(join(ROOT, 'CLA.md'), 'utf8'),
    claCommit: process.env.CLA_COMMIT,
  });
  if (out.decision.action === 'ignore') {
    console.log(`IGNORED: ${out.decision.reason}`);
    return;
  }
  if (out.signed) console.log(`SIGNATURE: ${out.signed}`);
  if (out.decision.action === 'backfill') console.log(`BACKFILLED: ${out.alsoChecked.length} open pull request(s).`);
  else if (!out.result) console.log(`SKIPPED: #${out.decision.number} is not open.`);
  else console.log(`CLA ${out.result.state.toUpperCase()}: ${out.result.description}`);
  if (out.decision.action !== 'backfill' && out.alsoChecked.length) console.log(`ALSO RECHECKED: ${out.alsoChecked.map((n) => `#${n}`).join(', ')}`);
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error instanceof ClaGateError) {
      console.error(`❌ ${error.reason}: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
