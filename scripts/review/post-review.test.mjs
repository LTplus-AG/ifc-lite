/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The poster is driven as a PROCESS -- real argv, real config reads, real exit
 * codes, real `spawnSync('gh', ...)` -- because that is what CI runs.
 *
 * THE SEAM IS A FAKE `gh` ON PATH, NOT A FLAG IN THE SCRIPT. post-review.mjs
 * carries no `--gh-state`, no injected transport and no `if (TEST)` branch, so
 * the bytes under test are the shipped bytes, ORDERING INCLUDED -- and ordering
 * is the entire thing this file exists to pin. A seam inside the script would
 * have been a second implementation of the one behaviour that matters.
 *
 * The fake records an ORDERED CALL LOG, which is how the order is asserted
 * rather than described: a test that only checks the final comments cannot tell
 * "marker after read-back" from "marker before read-back", and that difference
 * IS the bug (claude-code-action#1679).
 *
 * The last defence against drift is that this file runs the REAL gate,
 * ../check-review-posted.mjs, over exactly what the poster posted. The poster's
 * read-back predicate and the gate's FINDINGS_NOT_POSTED predicate are
 * deliberate duplicates; prose cannot keep two copies in step, so they are
 * checked by execution instead.
 *
 * Both directions for every verdict. A poster that has only been seen to post
 * has not been seen to refuse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'post-review.mjs');

// The rest of this file drives the script as a SUBPROCESS, which is right for the
// GitHub-facing behaviour. The posting cap is a pure function of the findings
// file, so it is exercised directly.
import {
  readFindings,
  readFindingsDoc,
  MAX_POSTED_FINDINGS,
  summaryBody,
  readJudgedAway,
  readCappedCount,
  marker,
} from './post-review.mjs';

/**
 * `readFindings` takes the PARSED document now, not a path: findings.json is
 * read and parsed once per run by `readFindingsDoc` and handed to all four
 * readers. This keeps each test writing a real file, so the parse is still
 * exercised, without repeating the two-call shape at every site.
 */
const readFindingsFile = (path) => readFindings(readFindingsDoc(path), path);
const GATE = join(HERE, '..', 'check-review-posted.mjs');
const SHIPPED_CFG = join(HERE, '..', 'review-posted.config.json');
const SHIPPED = JSON.parse(readFileSync(SHIPPED_CFG, 'utf8'));

const TMP = mkdtempSync(join(tmpdir(), 'post-review-'));
const BIN = join(TMP, 'bin');
mkdirSync(BIN);
let seq = 0;

const SHA = 'a'.repeat(40);
const MOVED_SHA = 'b'.repeat(40);
const REPO = 'ifc-lite/ifc-lite';
const PR = '4242';
const REVIEWER = 'github-actions';

/**
 * The gate ships `advisory` because the reviewer lane is not on yet. A verdict
 * test asks about POLICY, so the gate is driven with `enforcing`.
 */
const ENFORCING_CFG = join(TMP, 'cfg-enforcing.json');
writeFileSync(ENFORCING_CFG, JSON.stringify({ ...SHIPPED, mode: 'enforcing' }));

/**
 * A `gh` that answers the five calls the poster makes, records every one in
 * order, and can be told to fail any of them.
 *
 * The important fault it can inject is not "the POST failed" -- that one is
 * loud. It is `dropInlinePosts`: the POST returns 201 with a comment id and the
 * comment never exists. That is claude-code-action#1679 verbatim, and it is
 * invisible to anything that trusts a response.
 */
const FAKE_GH = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const file = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const argv = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 2));
const die = (msg) => { save(); process.stderr.write(msg); process.exit(1); };

if (argv[0] !== 'api') die('fake gh: only \`gh api\` is modelled, got: ' + argv.join(' '));
// GraphQL is a different shape entirely: one endpoint, the question in a
// variable. It is modelled because review-thread RESOLUTION exists nowhere in
// REST (#3768), so a fake that only speaks REST cannot tell a resolved finding
// from a live one -- which is the whole distinction under test.
if (argv[1] === 'graphql') {
  st.calls.push('POST graphql');
  if (st.graphqlFails) die('simulated GraphQL failure');
  const resolved = new Set(st.resolvedCommentIds || []);
  const nodes = (st.reviewComments || []).map((c) => ({
    isResolved: resolved.has(c.id),
    // fullDatabaseId is a GraphQL BigInt and comes back as a STRING. A fake that
    // returned a number would let a Number/String mix-up pass here and fail live.
    // \`threadCommentsTruncated\` models a RESOLVED thread with more than one
    // page of comments. The outer walk still finishes, so \`complete\` is true
    // while part of the answer was never read -- the shape the caller has to
    // disclose.
    comments: { pageInfo: { hasNextPage: !!st.threadCommentsTruncated }, nodes: [{ fullDatabaseId: String(c.id) }] },
  }));
  save();
  process.stdout.write(JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null }, nodes,
    } } } },
  }));
  process.exit(0);
}
const full = argv[1];
const url = full.split('?')[0];
const q = new URLSearchParams(full.split('?')[1] || '');
const page = Number(q.get('page') || '1');
const per = Number(q.get('per_page') || '100');
const mi = argv.indexOf('--method');
const method = mi === -1 ? 'GET' : argv[mi + 1];
const fields = {};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '-f' || argv[i] === '-F') {
    const v = String(argv[i + 1]);
    const eq = v.indexOf('=');
    fields[v.slice(0, eq)] = v.slice(eq + 1);
  }
}
const rel = url.replace(/^repos\\/[^/]+\\/[^/]+\\//, '');
st.calls.push(method + ' ' + rel);
const nextId = () => { st.nextId = (st.nextId || 1000) + 1; return st.nextId; };
const pageOf = (list) => list.slice((page - 1) * per, page * per);

let out;
if (method === 'GET' && /^pulls\\/\\d+$/.test(rel)) {
  out = { head: { sha: st.head } };
} else if (method === 'GET' && /^pulls\\/\\d+\\/comments$/.test(rel)) {
  out = pageOf(st.reviewComments);
} else if (method === 'GET' && /^issues\\/\\d+\\/comments$/.test(rel)) {
  out = pageOf(st.issueComments);
} else if (method === 'POST' && /^pulls\\/\\d+\\/comments$/.test(rel)) {
  st.inlinePostCount = (st.inlinePostCount || 0) + 1;
  const n = st.inlinePostCount;
  if (st.failInlinePost === n) die('simulated 422 Unprocessable Entity on inline comment ' + n);
  const rec = {
    id: nextId(),
    user: { login: st.author },
    commit_id: fields.commit_id,
    // GitHub mints BOTH on creation and only ever moves the first (#3729). A
    // fake emitting commit_id alone would let the poster read back a field the
    // real API relocates onto a later head.
    original_commit_id: fields.commit_id,
    path: fields.path,
    line: Number(fields.line),
    side: fields.side,
    body: fields.body,
  };
  // The #1679 shape: reported as created, never stored.
  if (!(st.dropInlinePosts || []).includes(n)) st.reviewComments.push(rec);
  out = st.inlinePostNoId === n ? { message: 'ok' } : rec;
} else if (method === 'POST' && /^issues\\/\\d+\\/comments$/.test(rel)) {
  const rec = { id: nextId(), user: { login: st.author }, body: fields.body };
  if (!st.dropSummaryPost) st.issueComments.push(rec);
  out = st.summaryPostNoId ? { message: 'ok' } : rec;
} else if (method === 'PATCH' && /^issues\\/comments\\/\\d+$/.test(rel)) {
  const id = Number(rel.split('/').pop());
  const rec = (st.issueComments || []).find((c) => c.id === id);
  if (!rec) die('fake gh: no such comment ' + id);
  rec.body = fields.body;
  out = rec;
} else {
  die('fake gh: unhandled ' + method + ' ' + rel);
}
save();
process.stdout.write(JSON.stringify(out));
`;
writeFileSync(join(BIN, 'gh'), FAKE_GH);
chmodSync(join(BIN, 'gh'), 0o755);

/**
 * A findings.json from a VALIDATED CLEAN REVIEW (#3862).
 *
 * `{ findings: [] }` alone is no longer enough to earn a `clean` marker: the
 * poster wants the flag validate-findings writes when `checkClassPass` accepted
 * a per-class pass, because an empty findings array is also what a `findings`
 * verdict looks like after the judge has dropped every one of them. Tests that
 * mean "the reviewer read this diff and found nothing" say so through this.
 */
const cleanDoc = (patch = {}) => JSON.stringify({ headSha: SHA, verdict: 'clean', classPass: true, findings: [], ...patch });

/** A finding, distinct per index in path, line and body. */
const finding = (n) => ({
  path: `packages/a/src/f${n}.ts`,
  line: 10 + n,
  body: `Finding ${n}: this index can go negative and the slice silently returns [].`,
});

/**
 * Run the poster against a fresh fake-`gh` world and hand back both its output
 * and the world it left behind.
 */
function runPoster({ state = {}, findings = [], findingsRaw, findingsPath, args = [], sha = SHA, author = REVIEWER } = {}) {
  const dir = join(TMP, `run-${(seq += 1)}`);
  mkdirSync(dir);
  const statePath = join(dir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      head: sha,
      author: REVIEWER,
      issueComments: [],
      reviewComments: [],
      calls: [],
      nextId: 1000,
      inlinePostCount: 0,
      dropInlinePosts: [],
      ...state,
    }),
  );
  const fPath = findingsPath ?? join(dir, 'findings.json');
  if (!findingsPath) writeFileSync(fPath, findingsRaw ?? JSON.stringify(findings));
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--pr', PR, '--repo', REPO, '--sha', sha, '--findings', fPath, '--author', author, ...args],
    { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FAKE_GH_STATE: statePath } },
  );
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}`,
    state: JSON.parse(readFileSync(statePath, 'utf8')),
    statePath,
  };
}


/** The poster on the NOTHING-TO-REVIEW path: no findings file at all. */
function runNothingToReview({ state = {}, sha = SHA, args = [], author = REVIEWER, ntr = true } = {}) {
  const dir = join(TMP, `ntr-${(seq += 1)}`);
  mkdirSync(dir);
  const statePath = join(dir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      head: sha,
      author: REVIEWER,
      issueComments: [],
      reviewComments: [],
      calls: [],
      nextId: 1000,
      inlinePostCount: 0,
      dropInlinePosts: [],
      ...state,
    }),
  );
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--pr', PR, '--repo', REPO, '--sha', sha, ...(ntr ? ['--nothing-to-review'] : []), '--author', author, ...args],
    { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FAKE_GH_STATE: statePath } },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}`, state: JSON.parse(readFileSync(statePath, 'utf8')) };
}

/**
 * Re-run the poster against a world a previous run left behind.
 *
 * `raw` overrides the findings file wholesale, because a bare array carries no
 * `classPass` flag and #3862 reads that absence as `clean-by-judge`. A rerun that
 * has to reach a plain `clean` marker passes `cleanDoc()` here.
 */
function rerunPoster(statePath, findings, sha = SHA, raw) {
  const fPath = join(TMP, `findings-rerun-${(seq += 1)}.json`);
  writeFileSync(fPath, raw ?? JSON.stringify(findings));
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--pr', PR, '--repo', REPO, '--sha', sha, '--findings', fPath, '--author', REVIEWER],
    { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FAKE_GH_STATE: statePath } },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}`, state: JSON.parse(readFileSync(statePath, 'utf8')) };
}

/** Everything the PR ended up carrying, as one string. */
const allBodies = (state) =>
  [...state.issueComments, ...state.reviewComments].map((c) => c.body).join('\n');

/** THE INVARIANT ON EVERY FAILURE PATH: the PR must be left marker-less. */
function assertNoMarker(state, why) {
  assert.doesNotMatch(allBodies(state), /ifc-lite-review/, why);
}

/** Run the REAL gate over exactly what the poster left on the PR. */
function runGate(state, sha = SHA) {
  const p = join(TMP, `gate-state-${(seq += 1)}.json`);
  writeFileSync(
    p,
    JSON.stringify({ headRepo: 'LTplus-AG/ifc-lite', issueComments: state.issueComments, reviewComments: state.reviewComments, reviews: [] }),
  );
  const r = spawnSync(
    process.execPath,
    [GATE, '--pr', PR, '--sha', sha, '--repo', 'LTplus-AG/ifc-lite', '--state-file', p, '--config', ENFORCING_CFG],
    { encoding: 'utf8' },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ================================================================== happy paths

test('PASS: a clean run posts exactly one marker comment and no inline comments', () => {
  const r = runPoster({ findingsRaw: cleanDoc() });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.issueComments.length, 1);
  assert.equal(r.state.reviewComments.length, 0);
  assert.match(r.state.issueComments[0].body, new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=clean count=0 -->`));
  assert.match(r.out, /REVIEW_POSTED/);
});

/** The body the poster actually posts: sanitised text plus the class tag it
 *  appends so a later precision tally has something durable to key on. */
const posted = (f) => `${f.body}\n\n<!-- ifc-lite-finding v=1 class=${(f.class || 'unclassified').replace(/[^a-z0-9-]/gi, '-')} -->`;

test('PASS: a findings run posts every finding with the fields GitHub requires', () => {
  const findings = [finding(1), finding(2), finding(3)];
  const r = runPoster({ findings });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.reviewComments.length, 3);
  for (const [i, c] of r.state.reviewComments.entries()) {
    assert.equal(c.commit_id, SHA);
    // THE FIELD THE GATE COUNTS (#3729). `commit_id` relocates onto a later
    // head; `original_commit_id` is what says the row was WRITTEN here.
    assert.equal(
      c.original_commit_id,
      SHA,
      'a finding not WRITTEN at this head is invisible to the gate',
    );
    assert.equal(c.side, 'RIGHT');
    assert.equal(c.path, findings[i].path);
    assert.equal(c.line, findings[i].line);
    // The posted body is the finding text PLUS the class tag, which is what makes
    // a later precision-by-class tally possible at all.
    assert.equal(c.body, posted(findings[i]));
    assert.match(c.body, /<!-- ifc-lite-finding v=1 class=/);
    // ...and that tag must never be mistakable for a review MARKER, or the
    // poster would be laundering a forged verdict through its own identity.
    assert.doesNotMatch(c.body, /<!--\s*ifc-lite-review\s+sha=/);
  }
  assert.equal(r.state.issueComments.length, 1);
  assert.match(
    r.state.issueComments[0].body,
    new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=findings count=3 -->`),
  );
});

test('the summary carries a numbered index and the false-positive footer', () => {
  const r = runPoster({ findings: [finding(1), finding(2)] });
  const body = r.state.issueComments[0].body;
  assert.match(body, /1\. `packages\/a\/src\/f1\.ts:11`/);
  assert.match(body, /2\. `packages\/a\/src\/f2\.ts:12`/);
  assert.match(body, /React with 👎 on a finding you think is wrong/);
  // The footer must NOT claim a logging step that does not exist. An earlier
  // wording said a reaction would "log it as a false positive"; nothing logged
  // anything, which is a note that fails to fire.
  assert.doesNotMatch(body, /log it as a false positive/);
});

test('a CLEAN summary omits the false-positive footer', () => {
  // Deliberate deviation from the brief, and the same rule the sibling gate's
  // harness pins for its advisory notice: a line describing findings, printed
  // where there are none, is the same class of lie as a green tick over an
  // unreviewed diff.
  const r = runPoster({ findings: [] });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.state.issueComments[0].body, /false positive/);
});

// ========================================================== the ORDER, asserted

test('THE ORDER: every inline POST, then a read-back GET, then the marker', () => {
  // The whole point of the file. A test that only inspects the final comments
  // cannot tell "marker after read-back" from "marker before read-back", and
  // that difference IS #1679.
  const r = runPoster({ findings: [finding(1), finding(2)] });
  assert.equal(r.code, 0, r.out);
  const calls = r.state.calls;
  const lastInlinePost = calls.lastIndexOf(`POST pulls/${PR}/comments`);
  const markerPost = calls.indexOf(`POST issues/${PR}/comments`);
  assert.ok(lastInlinePost >= 0 && markerPost >= 0, calls.join(' | '));
  assert.ok(markerPost > lastInlinePost, `marker must follow every finding: ${calls.join(' | ')}`);
  const readBack = calls.indexOf(`GET pulls/${PR}/comments`, lastInlinePost + 1);
  assert.ok(readBack >= 0, `a read-back GET must exist after the last POST: ${calls.join(' | ')}`);
  assert.ok(readBack < markerPost, `the read-back must precede the marker: ${calls.join(' | ')}`);
  // And the head re-read comes first of all.
  assert.equal(calls[0], `GET pulls/${PR}`);
});

// ====================================== the poster and the gate cannot disagree

test('the REAL gate reads REVIEW_POSTED from what a CLEAN run posted', () => {
  const r = runPoster({ findingsRaw: cleanDoc() });
  const g = runGate(r.state);
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /REVIEW_POSTED/);
  assert.match(g.out, /clean verdict/);
});

test('the REAL gate reads REVIEW_POSTED from what a FINDINGS run posted', () => {
  // This is the drift-killer: the poster's read-back predicate and the gate's
  // FINDINGS_NOT_POSTED predicate are deliberate duplicates, and prose cannot
  // hold two copies in step. Executing one against the other can.
  const r = runPoster({ findings: [finding(1), finding(2), finding(3)] });
  const g = runGate(r.state);
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /findings verdict.*with 3 finding/);
});

// ============================================================== the #1679 shape

test('FAIL: POSTs that report success and store nothing leave NO marker', () => {
  // Every POST returns 201 with an id; not one comment exists. This is the run
  // that logs `Posted 0/N` and exits 0 upstream.
  const r = runPoster({ findings: [finding(1), finding(2)], state: { dropInlinePosts: [1, 2] } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /READBACK_SHORT/);
  assert.match(r.out, /#1679/);
  assert.equal(r.state.reviewComments.length, 0);
  assertNoMarker(r.state, 'a dropped comment must not be certified by a marker');
});

test('FAIL: the marker count comes from the READ-BACK, not from the findings file', () => {
  // The findings file claims 3. The PR ends up holding 2. A poster that trusted
  // its own input would write `count=3` over a finding nobody can see -- the
  // marker would be a receipt for the model's claim instead of evidence about
  // the pull request.
  const r = runPoster({ findings: [finding(1), finding(2), finding(3)], state: { dropInlinePosts: [3] } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /READBACK_SHORT/);
  assert.match(r.out, /Read back 2 inline comment\(s\)/);
  assert.match(r.out, /has 3 finding\(s\)/);
  assert.equal(r.state.reviewComments.length, 2, 'two really did land');
  assertNoMarker(r.state, 'two of three findings is not a reviewed diff');
  // And the gate agrees, from the other side.
  const g = runGate(r.state);
  assert.equal(g.code, 1, g.out);
  assert.match(g.out, /NOT_POSTED/);
});

test('the marker count is what the READ-BACK sees, even when it EXCEEDS the findings file', () => {
  // THE OTHER DIRECTION of the same rule, and the one READBACK_SHORT cannot
  // reach: an earlier run left a finding on this head that this run's file no
  // longer lists, so the PR carries three and the file claims two. `count` must
  // describe the PULL REQUEST.
  //
  // Found by mutation. Replacing `count: confirmed` with `count: findings.length`
  // survived the entire suite, because every other case had the two numbers
  // equal -- a check whose input never varies is a check that cannot fail. The
  // summary now prints both numbers for the same reason.
  const older = {
    id: 800,
    user: { login: REVIEWER },
    commit_id: SHA,
    original_commit_id: SHA,
    path: 'packages/a/src/older.ts',
    line: 7,
    side: 'RIGHT',
    body: 'A finding from an earlier run against this same head.',
  };
  const r = runPoster({ findings: [finding(1), finding(2)], state: { reviewComments: [older] } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.reviewComments.length, 3);
  const body = r.state.issueComments[0].body;
  assert.match(body, /count=3 -->/, 'the marker counts the PR, not the file');
  assert.doesNotMatch(body, /count=2 -->/);
  assert.match(body, /### Claude review - 2 findings/, 'the heading and index describe what THIS run found');
  assert.match(body, /3 inline comments from this reviewer stand on this commit/);
});

test('FAIL: an inline POST that FAILS aborts with no marker and no further posts', () => {
  const r = runPoster({ findings: [finding(1), finding(2), finding(3)], state: { failInlinePost: 2 } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /GH_ERROR/);
  assert.equal(r.state.reviewComments.length, 1, 'it must stop, not carry on past a failure');
  assert.equal(r.state.inlinePostCount, 2, 'and not attempt finding 3');
  assertNoMarker(r.state, 'a half-posted review must leave the gate reading NOT_POSTED');
});

test('FAIL: a 2xx carrying no comment id is not a posted comment', () => {
  const r = runPoster({ findings: [finding(1)], state: { inlinePostNoId: 1 } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /INLINE_POST_FAILED/);
  assertNoMarker(r.state, 'a response without an id is not evidence of a comment');
});

test('FAIL: a marker that cannot be read back is not a success', () => {
  const r = runPoster({ findings: [], state: { dropSummaryPost: true } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /MARKER_NOT_READ_BACK/);
  assert.equal(r.state.issueComments.length, 0);
});

test('FAIL: a summary response with no id is SUMMARY_POST_FAILED', () => {
  const r = runPoster({ findings: [], state: { summaryPostNoId: true, dropSummaryPost: true } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SUMMARY_POST_FAILED/);
});

// ================================================================= a moved head

test('SKIPPED_STALE: a head that moved posts NOTHING and exits 0', () => {
  const r = runPoster({ sha: SHA, state: { head: MOVED_SHA }, findings: [finding(1), finding(2)] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SKIPPED_STALE/);
  assert.equal(r.state.reviewComments.length, 0);
  assert.equal(r.state.issueComments.length, 0);
  assert.deepEqual(r.state.calls, [`GET pulls/${PR}`], 'the head re-read is the only call it may make');
});

test('SKIPPED_STALE leaves no marker for the DEAD head', () => {
  // A marker naming the old head is one the gate calls STALE_REVIEW, and no
  // re-run of that commit could ever clear it.
  const r = runPoster({ sha: SHA, state: { head: MOVED_SHA }, findings: [] });
  assertNoMarker(r.state, 'nothing may be written for a head that no longer exists');
});

// ===================================================== dedupe and safe re-runs

test('a finding already present on this head is not posted twice', () => {
  const findings = [finding(1), finding(2), finding(3)];
  const seeded = {
    id: 900,
    user: { login: REVIEWER },
    commit_id: SHA,
    original_commit_id: SHA,
    path: findings[1].path,
    line: findings[1].line,
    side: 'RIGHT',
    body: posted(findings[1]),
  };
  const r = runPoster({ findings, state: { reviewComments: [seeded] } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.inlinePostCount, 2, 'the duplicate must be skipped, not re-sent');
  assert.equal(r.state.reviewComments.length, 3);
  assert.match(r.out, /posted 2, already present 1/);
  assert.match(r.state.issueComments[0].body, /count=3 -->/, 'the marker counts what is THERE, not what it sent');
});

test('#3729: a RELOCATED stale row does not swallow the finding, nor confirm it', () => {
  // THREE DEFECTS IN ONE ROW, all from `commit_id === sha`. GitHub relocates
  // that field onto a later head (#3729; the measured rows are in
  // scripts/lib/review-provenance.mjs), so a row from an earlier head that
  // still fingerprints the same finding used to:
  //   STEP 2 -- read as "already present at this head", so the finding was
  //            SKIPPED and never posted; and
  //   STEP 3 -- be counted as the read-back confirmation that it HAD been.
  // The two cancel: the marker claims a finding that is not on this head, which
  // is exactly the #1679 shape the read-back exists to catch.
  const findings = [finding(1)];
  const relocated = {
    id: 950,
    user: { login: REVIEWER },
    // Claims this head...
    commit_id: SHA,
    // ...and was written against the previous one.
    original_commit_id: 'c'.repeat(40),
    path: findings[0].path,
    line: findings[0].line,
    side: 'RIGHT',
    body: posted(findings[0]),
  };
  const r = runPoster({ findings, state: { reviewComments: [relocated] } });
  assert.equal(r.code, 0, r.out);
  // The finding is POSTED rather than deduped away against a stale row.
  assert.equal(r.state.inlinePostCount, 1, 'a relocated row is not "already present"');
  assert.match(r.out, /posted 1, already present 0/);
  // And the marker counts the row written HERE, not the relocated one.
  assert.match(r.state.issueComments[0].body, /count=1 -->/);
  const written = r.state.reviewComments.filter((c) => c.original_commit_id === SHA);
  assert.equal(written.length, 1);
});

test('#3729: a RELOCATED finding does not contradict a clean run; one WRITTEN here does', () => {
  // THE FALSE POSITIVE THE SAME FIELD CAUSED, in the other direction: a
  // genuinely clean run was contradicted because a stale finding had been
  // relocated onto its head. The contradiction must count evidence WRITTEN
  // here and only that. (#3761 turned the contradiction from a throw into a
  // standing `findings` marker, so both halves exit 0 and differ in the
  // marker's verdict.)
  const relocated = {
    id: 951,
    user: { login: REVIEWER },
    commit_id: SHA,
    original_commit_id: 'c'.repeat(40),
    path: 'packages/a/src/x.ts',
    line: 3,
    side: 'RIGHT',
    body: 'An earlier head\'s finding, relocated onto this one.',
  };
  // `cleanDoc()`, NOT `findings: []` (#3862). A bare array carries no class-pass
  // flag, so the poster now writes `clean-by-judge` for it -- and `/verdict=clean/`
  // matches that as a PREFIX, so this test would have gone on passing while
  // asserting something it no longer meant. What it is about is `clean` versus
  // `findings`, so it feeds a validated clean review and matches the whole token.
  const r = runPoster({ findingsRaw: cleanDoc(), state: { reviewComments: [relocated] } });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /CONTRADICTED/);
  assert.match(allBodies(r.state), /verdict=clean count=0/);
  // ANTI-VACUITY: the same row WRITTEN at this head still contradicts. The only
  // difference between the two inputs is `original_commit_id`.
  const real = runPoster({
    findingsRaw: cleanDoc(),
    state: { reviewComments: [{ ...relocated, original_commit_id: SHA }] },
  });
  assert.equal(real.code, 0, real.out);
  assert.match(real.out, /CONTRADICTED/);
  assert.match(allBodies(real.state), /verdict=findings count=1/);
  assert.doesNotMatch(allBodies(real.state), /verdict=clean /, 'nor `clean-by-judge`, which shares the prefix');
});

test('a finding whose body already exists at ANOTHER line or path is still posted', () => {
  // A body-only fingerprint would silently drop these, and a dropped finding is
  // indistinguishable from a finding that was never made.
  //
  // THE SEEDED COMMENT IS LOAD-BEARING. The first version of this test fed two
  // same-bodied findings into an empty PR and asserted both landed -- which is
  // true under a body-only fingerprint too, because the dedupe set is built from
  // comments ALREADY on the head and never updated inside the loop. Mutation
  // caught it: hashing the body alone survived the whole suite. The collision
  // has to be against something already on the PR to be observable at all.
  const body = 'Same wording, two places.';
  const seed = (id, path, line) => ({
    id,
    user: { login: REVIEWER },
    commit_id: SHA,
    original_commit_id: SHA,
    path,
    line,
    side: 'RIGHT',
    body,
  });

  const otherLine = runPoster({
    findings: [{ path: 'packages/a/src/x.ts', line: 91, body }],
    state: { reviewComments: [seed(902, 'packages/a/src/x.ts', 4)] },
  });
  assert.equal(otherLine.code, 0, otherLine.out);
  assert.equal(otherLine.state.inlinePostCount, 1, 'a different line is a different finding');
  assert.ok(otherLine.state.reviewComments.some((c) => c.line === 91), 'line 91 must be on the PR');

  const otherPath = runPoster({
    findings: [{ path: 'packages/b/src/y.ts', line: 4, body }],
    state: { reviewComments: [seed(903, 'packages/a/src/x.ts', 4)] },
  });
  assert.equal(otherPath.code, 0, otherPath.out);
  assert.equal(otherPath.state.inlinePostCount, 1, 'a different file is a different finding');
  assert.ok(otherPath.state.reviewComments.some((c) => c.path === 'packages/b/src/y.ts'));
});

test('a RE-RUN is idempotent: one marker comment, no duplicate findings', () => {
  const findings = [finding(1), finding(2)];
  const first = runPoster({ findings });
  assert.equal(first.code, 0, first.out);
  const second = rerunPoster(first.statePath, findings);
  assert.equal(second.code, 0, second.out);
  assert.equal(second.state.reviewComments.length, 2, 'the findings must not double-post');
  assert.equal(second.state.issueComments.length, 1, 'the marker must be updated in place, not duplicated');
  assert.match(second.state.calls.join(' | '), new RegExp(`PATCH issues/comments/`));
  const g = runGate(second.state);
  assert.equal(g.code, 0, g.out);
});

test('FAIL: a re-run cannot LAUNDER a finding that is STILL missing', () => {
  // The read-back requirement is `>= findings.length`, not `>= posted`, and this
  // is the case that separates them. The second finding is dropped on both
  // attempts. Against `posted` the re-run would skip finding 1 as a duplicate,
  // post finding 2, see one comment, satisfy `1 >= 1` and write `count=1` for a
  // two-finding review -- laundering an earlier run's loss into a pass.
  const findings = [finding(1), finding(2)];
  const first = runPoster({ findings, state: { dropInlinePosts: [2, 3] } });
  assert.equal(first.code, 1, first.out);
  const second = rerunPoster(first.statePath, findings);
  assert.equal(second.code, 1, second.out);
  assert.match(second.out, /READBACK_SHORT/);
  assert.match(second.out, /1 posted this run/);
  assertNoMarker(second.state, 'a re-run must not certify a finding that is still missing');
});

test('a re-run after a TRANSIENT drop re-posts the finding and then passes', () => {
  const findings = [finding(1), finding(2)];
  const first = runPoster({ findings, state: { dropInlinePosts: [2] } });
  assert.equal(first.code, 1, first.out);
  const second = rerunPoster(first.statePath, findings);
  assert.equal(second.code, 0, second.out);
  assert.equal(second.state.reviewComments.length, 2);
  assert.match(second.state.issueComments[0].body, /count=2 -->/);
});

test('a clean run over our OWN standing findings records them instead of deadlocking', () => {
  // This used to throw CLEAN_CONTRADICTED and exit 1. The remedy it printed was
  // "re-run the review", but a re-run reproduces the state exactly: the prior
  // comment is still anchored, this run still finds nothing. So the lane failed
  // FOREVER on that commit until a human deleted a comment. Measured on #3669:
  // three consecutive runs, identical failure, no path out.
  //
  // The requirement that mattered has not changed and is still asserted below:
  // a `verdict=clean` marker must never bury a live finding. What changed is
  // that the honest outcome -- the findings STAND -- is now reachable.
  const seeded = {
    id: 901,
    user: { login: REVIEWER },
    commit_id: SHA,
    original_commit_id: SHA,
    path: 'packages/a/src/x.ts',
    line: 3,
    side: 'RIGHT',
    body: 'An earlier run of this same head found this.',
  };
  const r = runPoster({ findings: [], state: { reviewComments: [seeded] } });

  assert.equal(r.code, 0, `the lane must not deadlock:\n${r.out}`);
  assert.match(r.out, /CONTRADICTED/, 'the disagreement must be stated in the log, not swallowed');

  const bodies = allBodies(r.state);
  // THE ORIGINAL INVARIANT, unchanged.
  assert.doesNotMatch(bodies, /verdict=clean/, 'a clean marker must not bury a live finding');
  // ...and the marker the gate reads says findings, with the confirmed count.
  assert.match(bodies, new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=findings count=1`));
  // The summary must not contradict itself the way the generic body would:
  // "0 findings" as a heading over "1 inline comment confirmed".
  assert.doesNotMatch(bodies, /### Claude review - 0 finding/);
  assert.match(bodies, /standing finding/);

  // The file's stated last defence: run the REAL gate over what was posted.
  // A marker this module considers well-formed is worth nothing if the gate
  // that reads it disagrees, and that pairing is what this suite exists for.
  const g = runGate(r.state);
  assert.equal(g.code, 0, `the gate must accept the contradicted end state:\n${g.out}`);
});

test('WITHDRAWAL: a standing findings marker is DOWNGRADED to clean once the comments go', () => {
  // The escape hatch the old error described is the only thing that still needs
  // a human, and it must keep working. An earlier version of this test ran
  // `runPoster({ findings: [], state: { reviewComments: [] } })`, which is
  // byte-identical to the happy-path test above -- it exercised the code and
  // put NO pressure on the withdrawal property, and its comment claimed a
  // coverage it did not have. Mutation-checked: only a verdict-always-findings
  // mutant killed it, which the happy-path test already caught.
  //
  // The state that actually matters is the TRANSITION: a `findings` marker is
  // already standing from the contradicted run, the human deletes the inline
  // comment, and the re-run must PATCH that marker DOWN to clean rather than
  // leave a findings marker over a PR with no findings on it.
  const standing = {
    id: 700,
    user: { login: REVIEWER },
    body: `### Claude review - 1 standing finding for \`${SHA.slice(0, 9)}\`\n\n${'x'}\n\n${marker(SHA, 'findings', 1)}`,
  };
  const r = runPoster({ findingsRaw: cleanDoc(), state: { issueComments: [standing], reviewComments: [] } });
  assert.equal(r.code, 0, r.out);

  const bodies = allBodies(r.state);
  assert.match(
    bodies,
    new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=clean count=0`),
    'the standing findings marker must be downgraded to clean',
  );
  assert.doesNotMatch(bodies, /verdict=findings/, 'no findings marker may survive the withdrawal');
  // One marker comment, PATCHed in place -- not a second one posted alongside.
  assert.equal(
    r.state.issueComments.filter((c) => /ifc-lite-review sha=/.test(c.body ?? '')).length,
    1,
    'the withdrawal must PATCH the standing marker, not post a rival',
  );
});

// ========================================================= identity boundaries

test('FAIL: an author outside expectedAuthors refuses BEFORE any network call', () => {
  // A marker from an unexpected author is invisible to the gate, so posting one
  // would be a green poster over a red gate -- the exact drift this pairing
  // exists to make impossible.
  const r = runPoster({ findings: [finding(1)], author: 'some-contributor' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /AUTHOR_NOT_EXPECTED/);
  assert.deepEqual(r.state.calls, [], 'it must refuse before it touches the PR');
});

test('a bot-suffixed --author normalises onto the config entry', () => {
  const r = runPoster({ findings: [], author: 'github-actions[bot]' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.issueComments.length, 1);
});

test("FAIL: a read-back that sees only a STRANGER's comments does not count them", () => {
  // The fake attributes every comment to `st.author`. Point that at someone
  // else: the POSTs all succeed, the comments all exist, and none of them is
  // ours. Counting them would let a passer-by's comment certify a review.
  const r = runPoster({ findings: [finding(1)], state: { author: 'drive-by' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /READBACK_SHORT/);
  assertNoMarker(r.state, "someone else's comment is not our finding");
});

// ============================================================== findings input

test('FAIL: a MISSING findings file is not a clean review', () => {
  const r = runPoster({ findingsPath: join(TMP, 'does-not-exist.json') });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NO_FINDINGS_FILE/);
  assert.deepEqual(r.state.calls, [], 'nothing may be posted for a review it could not read');
});

test('FAIL: an unparseable or wrongly-shaped findings file refuses, never defaults to clean', () => {
  for (const [raw, reason] of [
    ['{ not json', 'BAD_FINDINGS'],
    ['null', 'BAD_FINDINGS'],
    ['{"result":"clean"}', 'BAD_FINDINGS'],
    ['[{"path":"a.ts","body":"x"}]', 'BAD_FINDING'],
    ['[{"path":"a.ts","line":0,"body":"x"}]', 'BAD_FINDING'],
    ['[{"path":"a.ts","line":"12","body":"x"}]', 'BAD_FINDING'],
    ['[{"path":"","line":2,"body":"x"}]', 'BAD_FINDING'],
    ['[{"path":"a.ts","line":2,"body":"  "}]', 'BAD_FINDING'],
    ['["just a string"]', 'BAD_FINDING'],
  ]) {
    const r = runPoster({ findingsRaw: raw });
    assert.equal(r.code, 1, `${raw}: ${r.out}`);
    assert.match(r.out, new RegExp(reason), `${raw} must be a classified refusal`);
    assert.deepEqual(r.state.calls, [], `${raw} must post nothing`);
    // A classified refusal, not a crash: a stack trace prints no remedy.
    assert.doesNotMatch(r.out, /\n\s+at [A-Za-z]/, `${raw} must not print a stack trace`);
  }
});

test('both accepted findings shapes work, and mean the same thing', () => {
  const bare = runPoster({ findingsRaw: JSON.stringify([finding(1)]) });
  const wrapped = runPoster({ findingsRaw: JSON.stringify({ findings: [finding(1)] }) });
  assert.equal(bare.code, 0, bare.out);
  assert.equal(wrapped.code, 0, wrapped.out);
  assert.match(bare.state.issueComments[0].body, /count=1 -->/);
  assert.match(wrapped.state.issueComments[0].body, /count=1 -->/);
});

// ============================================================= fail-closed args

test('FAIL-CLOSED: broken invocations refuse and post nothing', () => {
  const base = ['--pr', PR, '--repo', REPO, '--sha', SHA, '--author', REVIEWER];
  const fPath = join(TMP, 'args-findings.json');
  writeFileSync(fPath, '[]');
  const statePath = join(TMP, 'args-state.json');
  const fresh = () =>
    writeFileSync(
      statePath,
      JSON.stringify({ head: SHA, author: REVIEWER, issueComments: [], reviewComments: [], calls: [] }),
    );
  const attempt = (argv) => {
    fresh();
    const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FAKE_GH_STATE: statePath },
    });
    return {
      code: r.status,
      out: `${r.stdout}${r.stderr}`,
      state: JSON.parse(readFileSync(statePath, 'utf8')),
    };
  };

  const cases = [
    [[...base], /BAD_ARGS/, 'no --findings'],
    [['--repo', REPO, '--sha', SHA, '--author', REVIEWER, '--findings', fPath], /NO_PR/, 'no --pr'],
    [['--pr', 'twelve', '--repo', REPO, '--sha', SHA, '--author', REVIEWER, '--findings', fPath], /NO_PR/, 'bad --pr'],
    [['--pr', PR, '--repo', REPO, '--author', REVIEWER, '--findings', fPath], /NO_SHA/, 'no --sha'],
    [['--pr', PR, '--repo', REPO, '--sha', 'abc123', '--author', REVIEWER, '--findings', fPath], /NO_SHA/, 'short --sha'],
    [['--pr', PR, '--repo', REPO, '--sha', SHA, '--findings', fPath], /BAD_ARGS/, 'no --author'],
    // `{...}[name]` reaches Object.prototype, so this returned a truthy key and
    // wrote a junk property instead of refusing. A guard that does not guard
    // what it claims is the failure this whole lane is about, one level down.
    [[...base, '--findings', fPath, '--constructor', 'x'], /BAD_ARGS.*constructor/, 'prototype key'],
    [[...base, '--findings'], /BAD_ARGS/, 'flag with no value'],
  ];
  for (const [argv, want, what] of cases) {
    const r = attempt(argv);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, want, what);
    assert.deepEqual(r.state.calls, [], `${what} must post nothing`);
  }
});

test('FAIL-CLOSED: --repo is required and is not guessed', () => {
  const fPath = join(TMP, 'norepo-findings.json');
  writeFileSync(fPath, '[]');
  const statePath = join(TMP, 'norepo-state.json');
  writeFileSync(statePath, JSON.stringify({ head: SHA, author: REVIEWER, issueComments: [], reviewComments: [], calls: [] }));
  const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FAKE_GH_STATE: statePath };
  delete env.GITHUB_REPOSITORY;
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--pr', PR, '--sha', SHA, '--author', REVIEWER, '--findings', fPath],
    { encoding: 'utf8', env },
  );
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /NO_REPO/);
});

test('FAIL-CLOSED: a missing or broken config refuses rather than trusting the author', () => {
  const missing = runPoster({ findings: [], args: ['--config', '/nope/absent.json'] });
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /NO_CONFIG/);
  assert.deepEqual(missing.state.calls, []);

  const bad = join(TMP, 'cfg-broken.json');
  writeFileSync(bad, '{ not json');
  const broken = runPoster({ findings: [], args: ['--config', bad] });
  assert.equal(broken.code, 1, broken.out);
  assert.match(broken.out, /BAD_CONFIG/);
  assert.deepEqual(broken.state.calls, []);
});

test('the SHIPPED config is the one the poster runs against', () => {
  // No `--config` anywhere above except the two refusal cases, deliberately: a
  // shipped config whose `expectedAuthors` no longer covers the posting identity
  // would make every real run refuse, and a harness that always passed a temp
  // copy could not see it.
  const r = runPoster({ findings: [] });
  assert.equal(r.code, 0, r.out);
  assert.ok(SHIPPED.expectedAuthors.includes(REVIEWER), 'the posting identity must be an expected author');
});

// ============================================ nothing to review is its OWN verdict

test('END TO END: a nothing-to-review marker satisfies the REAL gate', () => {
  // The defect this closes: a lockfile-only PR makes build-review-input exit
  // NO_FILES, the lane skips posting, and under `mode: enforcing` the gate
  // reports NOT_POSTED on a row NO re-run and NO author action can clear --
  // the lane skips identically every time. PR #3558 is a live instance.
  const r = runNothingToReview();
  assert.equal(r.code, 0, r.out);
  assert.match(allBodies(r.state), /verdict=nothing-to-review count=0/);
  assert.equal(r.state.reviewComments.length, 0, 'no inline comments: nothing was read');

  const g = runGate(r.state);
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /REVIEW_POSTED/);
});

test('the gate PRINTS it as its own outcome, never as "reviewed and clean"', () => {
  // If this ever reads like a clean review, the distinction has collapsed and an
  // exclusion-list bug would certify every PR it swallowed as reviewed.
  const g = runGate(runNothingToReview().state);
  assert.match(g.out, /NOTHING TO REVIEW/);
  assert.match(g.out, /not a statement that the diff was read/);
});

test('it is NOT a `clean` marker, and that is the whole point', () => {
  const bodies = allBodies(runNothingToReview().state);
  assert.doesNotMatch(bodies, /verdict=clean/);
  assert.match(bodies, /The reviewer was NOT run/);
});

test('a `--reason` carrying the bare marker TOKEN outside any comment is defanged too', () => {
  // The private `defangMarkerText` this used to run through only escaped a
  // literal `<!--`; it left the bare `ifc-lite-review` token untouched in
  // ordinary text. `sanitizeBody` (imported from validate-findings.mjs, the
  // same sanitiser every finding body goes through) breaks that token
  // EVERYWHERE, not only inside a comment -- because this lane's own source
  // carries the token, so a build-input message that happens to quote it
  // would otherwise reach the comment body unbroken. Discriminating: this
  // input has no `<!--` at all, so the old defang would have left it
  // byte-identical.
  const r = runNothingToReview({ args: ['--reason', 'no reviewable files (ifc-lite-review excluded all of them)'] });
  assert.equal(r.code, 0, r.out);
  const body = allBodies(r.state);
  assert.doesNotMatch(body, /ifc-lite-review excluded/, 'the bare token must be broken, not passed through verbatim');
  assert.match(body, /excluded all of them/, 'the rest of the reason text must still reach the comment');
});

test('a marker for a DEAD head is not written on this path either', () => {
  // Same rule as the review path: a marker for a superseded head is one the gate
  // calls STALE_REVIEW, and no re-run of this commit could clear it.
  const r = runNothingToReview({ state: { head: 'b'.repeat(40) } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SKIPPED_STALE/);
  assertNoMarker(r.state, 'a dead head must leave the PR marker-less');
});

test('the read-back guards this path too: an unreadable marker REFUSES', () => {
  // The nothing-to-review path shares `upsertAndVerify` with the review path
  // precisely so it cannot skip the read-back. A second writer that posted
  // without verifying would be a hole in the shape of the bug this file exists
  // to refuse.
  const r = runNothingToReview({ state: { dropSummaryPost: true } });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /MARKER_NOT_READ_BACK|SUMMARY_POST_FAILED/);
});

test('`--nothing-to-review` and `--findings` together are refused', () => {
  // One says the model never ran; the other carries what it produced. A caller
  // passing both does not know which happened, and guessing would be the
  // absence-reads-as-success shape at the CLI.
  const dir = join(TMP, `both-${(seq += 1)}`);
  mkdirSync(dir);
  const f = join(dir, 'f.json');
  writeFileSync(f, '[]');
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--pr', PR, '--repo', REPO, '--sha', SHA, '--findings', f, '--nothing-to-review', '--author', REVIEWER],
    { encoding: 'utf8' },
  );
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /mutually exclusive/);
});

test('THE WIRING: the workflow actually takes this path when the input step skips', () => {
  // Static, because nothing else can reach it: the lane needs a runner and a
  // token. Without the step the bug returns silently, and the whole point of
  // this change is that a red nobody can clear must not come back.
  const wf = readFileSync(join(HERE, '..', '..', '.github/workflows/claude-review.yml'), 'utf8');
  const step = wf.split('- name: Say so when there was nothing to review')[1];
  assert.ok(step, 'the nothing-to-review step must exist in claude-review.yml');
  const guard = step.split('run:')[0];
  assert.match(guard, /steps\.input\.outputs\.skip == 'true'/, 'it must run ONLY on the skip path');
  assert.match(step, /--nothing-to-review/);
  // And the reviewing steps must NOT run on that path, or the model is invoked
  // with nothing to read.
  for (const other of ['Run the reviewer', 'Validate the findings', 'Post the review', 'Install the reviewer CLI']) {
    const s2 = wf.split(`- name: ${other}`)[1];
    assert.ok(s2, `${other} must exist`);
    assert.match(s2.split('run:')[0], /skip != 'true'/, `${other} must be excluded on the skip path`);
  }
});

test('THE MATCHED PAIR: every identity the lane posts as is one the GATE accepts', () => {
  // THE PAIR HAS NO OTHER GATE, and this repository has been bitten by that shape
  // before: two changes, each green alone, fatal together. The lane names the
  // identity it posts as in `claude-review.yml` (`--author`); the gate names the
  // identities whose marker counts in `review-posted.config.json`. Nothing else
  // connects them, so changing ONE is a silent break -- every marker the lane
  // writes becomes invisible, the gate reads NOT_POSTED on every head, and under
  // `mode: enforcing` that is the whole repository red.
  //
  // Live instance at the time of writing: PR #3583 replaces `expectedAuthors`
  // with a dedicated GitHub App that does not exist yet. Its own description says
  // the gate then "correctly reports NOT_POSTED" -- true and harmless under
  // advisory, and the entire repository under enforcing. This test is what turns
  // that from a surprise into a red line in whichever PR lands second.
  const wf = readFileSync(join(HERE, '..', '..', '.github/workflows/claude-review.yml'), 'utf8');
  const authors = [...wf.matchAll(/--author\s+(\S+)/g)].map((m) => m[1]);
  assert.ok(authors.length > 0, 'the lane must name the identity it posts as');

  const cfg = JSON.parse(readFileSync(join(HERE, '..', 'review-posted.config.json'), 'utf8'));
  const accepted = (cfg.expectedAuthors ?? []).map((a) => String(a).toLowerCase());
  assert.ok(accepted.length > 0, 'the gate must name at least one accepted identity');

  for (const a of authors) {
    assert.ok(
      accepted.includes(a.toLowerCase()),
      `the lane posts as \`${a}\`, which the gate does not accept (${accepted.join(', ')}). ` +
        'Every marker it writes would be invisible and the gate would read NOT_POSTED on every PR. ' +
        'Change BOTH or neither.',
    );
  }
});

test('a nothing-to-review run REFUSES to overwrite a real verdict for the same head', () => {
  // `upsertAndVerify` finds its carrier by sha alone, so without a guard this
  // would PATCH a `findings` summary into "nothing to review", retracting a real
  // verdict and orphaning its inline comments.
  const first = runPoster({ findings: [{ path: 'a.ts', line: 2, body: 'x' }] });
  assert.equal(first.code, 0, first.out);
  assert.match(allBodies(first.state), /verdict=findings/);

  // EXIT 0, not a throw. The refusal is right; reddening the lane for a state
  // that needs no action is not -- the gate is already satisfied by the standing
  // marker, and no re-run could clear that red. Reintroducing the unclearable-red
  // class inside the guard that removes it was the bug.
  const second = runNothingToReview({ state: first.state });
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /WOULD_DOWNGRADE_VERDICT/);
  assert.match(second.out, /nothing to do/);
  assert.match(allBodies(second.state), /verdict=findings/, 'the real verdict must still stand');
  assert.doesNotMatch(allBodies(second.state), /nothing-to-review/, 'and must not be overwritten');
});

// ============================================ the posting cap, on BOTH lane paths

/**
 * THE CAP LIVES HERE BECAUSE THIS MODULE ALWAYS RUNS.
 *
 * It used to live in run-judge.mjs. The workflow's crash backstop does
 * `cp findings.json judged.json` and never touches that module, and the
 * validator's own ceiling is twelve -- so the "at most five comments reach a
 * human" invariant held only when the optional filter succeeded, and the failure
 * path, the one that runs when something has already gone wrong, posted twelve.
 */
test('more findings than the cap are trimmed to the cap', () => {
  const p = join(TMP, 'cap-many.json');
  const many = Array.from({ length: MAX_POSTED_FINDINGS + 7 }, (_, i) => ({
    path: 'packages/a/f.ts',
    line: 1 + i,
    quote: `q${i}`,
    body: `body ${i}`,
  }));
  writeFileSync(p, JSON.stringify({ verdict: 'findings', findings: many }));
  const got = readFindingsFile(p);
  assert.equal(got.length, MAX_POSTED_FINDINGS);
  assert.match(got[0].body, /body 0/, 'the first ones, in the order given');
});

test('THE BYPASS PATH: an UNJUDGED file straight from the validator is still capped', () => {
  // This is the exact artefact the workflow copies when the judge crashes: the
  // validator's output, ceiling twelve, no `judged` field. Before the cap moved
  // here, this posted twelve inline comments.
  const p = join(TMP, 'cap-unjudged.json');
  const twelve = Array.from({ length: 12 }, (_, i) => ({
    path: 'packages/a/f.ts',
    line: 1 + i,
    quote: `q${i}`,
    body: `body ${i}`,
  }));
  writeFileSync(p, JSON.stringify({ verdict: 'findings', findings: twelve, counts: { valid: 12 } }));
  assert.equal(readFindingsFile(p).length, MAX_POSTED_FINDINGS);
});

test('at or under the cap nothing is trimmed', () => {
  const p = join(TMP, 'cap-few.json');
  const few = Array.from({ length: MAX_POSTED_FINDINGS }, (_, i) => ({
    path: 'packages/a/f.ts',
    line: 1 + i,
    quote: `q${i}`,
    body: `body ${i}`,
  }));
  writeFileSync(p, JSON.stringify({ verdict: 'findings', findings: few }));
  assert.equal(readFindingsFile(p).length, MAX_POSTED_FINDINGS);
});

test('a review the judge emptied does NOT read as a review that found nothing', () => {
  // The judge can reject every validated finding. Without this the PR shows
  // "found nothing to flag" and the only record that they existed is a runner
  // log that expires -- absence reading as success, on a path the judge created.
  const plain = summaryBody({ sha: 'a'.repeat(40), findings: [], count: 0, verdict: 'clean' });
  assert.match(plain, /found nothing to flag/);
  assert.doesNotMatch(plain, /dropped as too vague/, 'a genuinely clean review must not claim drops');

  const judged = summaryBody({ sha: 'a'.repeat(40), findings: [], count: 0, verdict: 'clean-by-judge', judgedAway: 4 });
  assert.match(judged, /4 finding\(s\) were written and then dropped/);
  assert.match(judged, /ifc-lite-review sha=/, 'the marker must still be written');
});

test('readJudgedAway returns 0 for any document that does not say, and never throws', () => {
  // It decorates a message. A malformed count must never be why a review fails
  // to post -- that would trade a cosmetic line for a missing marker. It takes
  // the parsed document now (#3688): the file is read once per run, so "could
  // not re-read it" is a failure that no longer exists rather than one handled.
  assert.equal(readJudgedAway(null), 0);
  assert.equal(readJudgedAway(undefined), 0);
  assert.equal(readJudgedAway([]), 0, 'a bare array carries no counts');

  // `judged: true` REQUIRED, and this test asserted the opposite by omission.
  // `counts.dropped` means "the judge rejected these" in judged.json and
  // "the validator refused these as malformed" in findings.json, which the
  // workflow's crash backstop copies verbatim. Without the flag the poster told
  // the author N findings were "dropped as too vague" about findings that had
  // actually quoted a line not in the diff.
  assert.equal(readJudgedAway({ judged: true, findings: [], counts: { dropped: 3 } }), 3);
  assert.equal(
    readJudgedAway({ findings: [], counts: { dropped: 3 } }),
    0,
    "the validator's own drops are not judge drops",
  );
});

test('readFindingsDoc owns the diagnosis for an unreadable or unparseable file', () => {
  // The four readers each carried their own answer to "what if this file is
  // bad", and one of them threw a message about a race that could only happen
  // BECAUSE it re-read. One read, one diagnosis (#3688).
  const bad = join(TMP, 'doc-bad.json');
  writeFileSync(bad, 'not json at all');
  assert.throws(() => readFindingsDoc(bad), /is not valid JSON/);
  assert.throws(() => readFindingsDoc(join(TMP, 'does-not-exist.json')), /is missing/);
  // The happy path, so the two assertions above cannot both be passing on a
  // function that throws unconditionally.
  const good = join(TMP, 'doc-good.json');
  writeFileSync(good, JSON.stringify({ findings: [], omitted: ['a.ts'] }));
  assert.deepEqual(readFindingsDoc(good), { findings: [], omitted: ['a.ts'] });
});

test('the VERIFIED SIBLING reaches the PR comment', () => {
  // The validator proves the twin exists in the pack the reviewer was shown and
  // the judge is given it -- and the poster used to drop it again, so on the
  // second-site family the whole context pack exists to catch, the twin's
  // location died with the runner. A comment in validate-findings claimed this
  // module rendered it. It did not.
  const p = join(TMP, 'sibling.json');
  writeFileSync(p, JSON.stringify({
    verdict: 'findings',
    findings: [{
      path: 'packages/data/src/property-table.ts',
      line: 12,
      quote: 'const key = psetName;',
      body: 'The duplicate in packages/cache still merges by name alone.',
      sibling: { path: 'packages/cache/src/sections/properties.ts', line: 88, quote: 'x' },
    }],
  }));
  const got = readFindingsFile(p);
  assert.match(got[0].body, /packages\/cache\/src\/sections\/properties\.ts:88/, 'the twin must be named');
  assert.match(got[0].body, /this PR does not change/);
});

test('a finding with no sibling gains no stray sentence', () => {
  const p = join(TMP, 'nosibling.json');
  writeFileSync(p, JSON.stringify({
    verdict: 'findings',
    findings: [{ path: 'packages/a/f.ts', line: 1, quote: 'q', body: 'A plain finding.' }],
  }));
  assert.doesNotMatch(readFindingsFile(p)[0].body, /same shape is at/);
});

test('the cap disclosure quotes the CONSTANT, not the word five', () => {
  // It said "capped at five" while the number came from MAX_POSTED_FINDINGS, so
  // changing the constant would have stated a false number to the author. This
  // branch had no coverage at all, on a PR whose previous round shipped a
  // ReferenceError on exactly such an uncovered path.
  const body = summaryBody({
    sha: 'a'.repeat(40),
    findings: [{ path: 'packages/a/f.ts', line: 1, body: 'x', title: null }],
    count: 1,
    capped: 3,
  });
  assert.match(body, /3 further finding\(s\) passed validation/);
  assert.match(body, new RegExp(`capped\\s+at ${MAX_POSTED_FINDINGS}`));
});

test('readCappedCount counts what the cap withheld, and never throws', () => {
  const doc = { findings: Array.from({ length: 9 }, () => ({})) };
  assert.equal(readCappedCount(doc, 5), 4);
  assert.equal(readCappedCount(doc, 9), 0, 'nothing withheld when all were shown');
  // Shapes that carry no total, which is what "unreadable" collapses to now
  // that the file is parsed once upstream (#3688).
  assert.equal(readCappedCount(null, 5), 0);
  assert.equal(readCappedCount({ findings: 'not an array' }, 5), 0);
  // A bare array is the other accepted spelling and must still count.
  assert.equal(readCappedCount(Array.from({ length: 9 }, () => ({})), 5), 4);
});

// ====================================== the partial-review disclosure (#3679)

test('PARTIAL CLEAN: the marker carries omitted=N and the REAL gate reads posted AND partial', () => {
  // The #3679 contract end to end: a review that could not read the whole diff
  // must end with a marker that says so -- never a silent clean and never an
  // unclearable red. `omitted` is what validate-findings copies out of the
  // degraded review-input; the gate below is the REAL gate over exactly what
  // this run posted.
  const r = runPoster({
    findingsRaw: cleanDoc({ omitted: ['packages/a/big.ts', 'packages/b/huge.ts'] }),
  });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.state.issueComments.length, 1);
  const body = r.state.issueComments[0].body;
  assert.match(body, new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=clean count=0 omitted=2 -->`));
  assert.match(body, /PARTIAL REVIEW: 2 changed file/);
  assert.match(body, /packages\/a\/big\.ts/);
  assert.match(body, /packages\/b\/huge\.ts/);
  assert.match(body, /Nothing vouches for those files/);
  assert.doesNotMatch(body, /Reviewed this diff and found nothing to flag/, 'the full-review sentence would be a lie here');
  const g = runGate(r.state);
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /REVIEW_POSTED/);
  assert.match(g.out, /PARTIAL: 2 changed file\(s\)/);
});

test('PARTIAL FINDINGS: the disclosure and the findings coexist on one marker', () => {
  const r = runPoster({
    findingsRaw: JSON.stringify({ findings: [finding(1)], omitted: ['packages/a/big.ts'] }),
  });
  assert.equal(r.code, 0, r.out);
  const body = r.state.issueComments[0].body;
  assert.match(body, new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=findings count=1 omitted=1 -->`));
  assert.match(body, /PARTIAL REVIEW: 1 changed file/);
  const g = runGate(r.state);
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /findings verdict.*with 1 finding/);
  assert.match(g.out, /PARTIAL: 1 changed file\(s\)/);
});

test('a FULL review still writes the marker BYTE-IDENTICAL to before #3679', () => {
  // Backwards compatibility is a property, not a hope: `omitted=` appears only
  // on a partial review, so every marker written for a fully-reviewed head
  // parses under the gate exactly as it always has -- including gates checked
  // out from branches that predate this change.
  const r = runPoster({ findingsRaw: cleanDoc() });
  assert.equal(r.code, 0, r.out);
  const body = r.state.issueComments[0].body;
  assert.match(body, new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=clean count=0 -->`));
  assert.doesNotMatch(body, /omitted=/);
  assert.doesNotMatch(body, /PARTIAL/);
});

test('FAIL: a malformed `omitted` refuses with NO marker rather than defaulting to a full review', () => {
  // Defaulting would post a marker byte-identical to a full review's over a
  // review that was partial -- absence reading as success, in the one field
  // whose whole job is to keep absence visible.
  for (const omitted of ['nope', [''], [42], {}]) {
    const r = runPoster({ findingsRaw: JSON.stringify({ findings: [], omitted }) });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /BAD_FINDINGS/);
    assertNoMarker(r.state, 'a refused omitted list must leave the PR marker-less');
  }
});

test('FAIL: an undefanged `omitted` entry refuses -- the sanitiser lives upstream and is REQUIRED', () => {
  // validate-findings defangs these paths before writing them. An entry that
  // still carries `<!--` or the marker token means the two files drifted, and
  // rendering it would hand a PR-chosen file path our posting identity.
  for (const evil of ['a<!--b.ts', `x-ifc-lite-review-y.ts`]) {
    const r = runPoster({ findingsRaw: JSON.stringify({ findings: [], omitted: [evil] }) });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /BAD_FINDINGS/);
    assertNoMarker(r.state, 'a forged omitted entry must never reach the PR');
  }
});

test('a LONG omitted list is capped in prose but exact in the marker', () => {
  const omitted = Array.from({ length: 25 }, (_, i) => `packages/a/f${i}.ts`);
  const r = runPoster({ findingsRaw: JSON.stringify({ findings: [], omitted }) });
  assert.equal(r.code, 0, r.out);
  const body = r.state.issueComments[0].body;
  assert.match(body, /omitted=25 -->/);
  assert.match(body, /and 5 more/);
  const g = runGate(r.state);
  assert.equal(g.code, 0, g.out);
  assert.match(g.out, /PARTIAL: 25 changed file\(s\)/);
});

test('an omitted PATH containing a backtick cannot close its code span early (#3688 review)', () => {
  // A git path may contain a backtick. The omitted list renders each path as a
  // Markdown inline code span, and a single-backtick pair lets the path close
  // the span at ITS backtick -- spilling the rest of the path (and anything an
  // author put after it) into the surrounding comment as live Markdown. The
  // fix is CommonMark's: fence with a run longer than the longest run in the
  // content, padded with one space each side.
  //
  // Decoded by the module-level `firstCodeSpan` (hoisted, defined below). This
  // file used to carry a SECOND, local decoder here whose close rule was
  // `run.length >= fence.length`. That is not CommonMark: a span closes only on
  // a run of EXACTLY the fence length, so the local one called a 2-run inside a
  // 1-fence "closed early" when a real renderer would not. Two oracles for one
  // format drift apart silently, and a wrong oracle can just as easily
  // manufacture a failure as hide one. One decoder, and it is the correct one.

  for (const evil of ['packages/a/we`ird.ts', 'packages/a/tw``o.ts', 'packages/a/ends`', '`starts/a.ts']) {
    const body = summaryBody({ sha: SHA, findings: [], count: 0, verdict: 'clean', omitted: [evil] });
    const line = body.split('\n').find((l) => l.startsWith('- '));
    assert.match(line, /^- /, 'the omitted entry must render as a bullet');
    // Equality IS the early-close check: a span that closed at the path's own
    // backtick decodes to a prefix, not to `evil`.
    assert.equal(
      firstCodeSpan(line.slice(2)),
      evil,
      `the whole path must survive as ONE code span: ${line}`,
    );
  }

  // The plain path keeps its plain single-backtick rendering: no fence inflation
  // on the common case, which every existing fixture in this file relies on.
  const plain = summaryBody({ sha: SHA, findings: [], count: 0, verdict: 'clean', omitted: ['packages/a/plain.ts'] });
  assert.match(plain, /^- `packages\/a\/plain\.ts`$/m);
});

// ============================== UNTRUSTED TEXT IN A CODE SPAN, at every site
//
// #3688 fixed ONE site: the omitted-path list. `inlineCode` existed from that
// commit, but the two sites that render DIFF-DERIVED paths still used a bare
// `` `${p}` `` -- the summary index (every findings run) and the sibling
// sentence. That split left the RARE path fixed and the COMMON one broken,
// which reads as fixed to the next person who greps and finds `inlineCode`.
//
// A git path may legally contain a backtick. Rendered into a one-backtick
// span, the path's own backtick CLOSES the span and the tail spills into the
// comment as live Markdown.

/**
 * Decode the first inline code span on a line the way CommonMark does: a span
 * opened by a run of N backticks closes at the next run of EXACTLY N, and the
 * renderer strips one space of padding at each end. Returns null when the span
 * never closes. Deliberately NOT the production helper -- an oracle that
 * shares the code under test cannot fail.
 */
function firstCodeSpan(line) {
  const open = /`+/.exec(line);
  if (open === null) return null;
  const fence = open[0];
  const rest = line.slice(open.index + fence.length);
  const close = new RegExp(`(?<!\`)${fence}(?!\`)`).exec(rest);
  if (close === null) return null;
  let inner = rest.slice(0, close.index);
  if (inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') inner = inner.slice(1, -1);
  return inner;
}

// Mutation-tested: with `inlineCode` reverted at both sites, every case fails
// EXCEPT the double-backtick pair -- and that exception is correct rather than
// a dud assertion. CommonMark closes a span only on a run of EQUAL length, so
// a ``-run cannot close a `-fence and that input was never broken. It stays as
// a boundary case, but it is NOT evidence the fix works; the mid-path,
// trailing and leading cases are. (Stated as the exception and its reason
// rather than as a ratio: a count goes stale the moment a row is added, and a
// stale count still reads as evidence.)
// The fence widens ONLY when the text needs it, and nothing here re-asserts
// that: an always-pad mutant is already caught by three existing tests --
// 'the summary carries a numbered index', the #3688 omitted-path test, and the
// posted-body fixture -- verified by running that mutant. A fourth assertion
// would have been a duplicate wearing a new name.
const EVIL = [
  ['a backtick mid-path', 'packages/a/we`ird.ts'],
  ['a double-backtick run', 'packages/a/we``ird.ts'],
  ['a trailing backtick', 'packages/a/weird.ts`'],
  ['a leading backtick', '`packages/a/weird.ts'],
];

// `indexLine` is reached through `summaryBody`, which is exported and pure, so
// these decode its return value directly. The four SIBLING cases below must
// stay on `readFindings` because that is where the sibling sentence is built.
// ONE end-to-end case follows the loop: enough to prove an evil path survives
// argv -> readFindings -> post, without paying a ~190 ms spawn per input for a
// defect that lives in a pure function.
const indexEntry = (body) => body.split('\n').find((l) => /^1\. /.test(l.trim()));

for (const [label, evilPath] of EVIL) {
  test(`the SUMMARY INDEX keeps a whole path in one span: ${label}`, () => {
    const body = summaryBody({
      sha: SHA,
      findings: [{ path: evilPath, line: 11, body: 'Body.' }],
      count: 1,
    });
    const line = indexEntry(body);
    assert.ok(line, 'the numbered index entry must exist');
    assert.equal(
      firstCodeSpan(line),
      `${evilPath}:11`,
      'the whole path:line must survive as ONE code span',
    );
  });

  test(`the SIBLING sentence keeps a whole path in one span: ${label}`, () => {
    const p = join(TMP, `evil-sibling-${(seq += 1)}.json`);
    writeFileSync(p, JSON.stringify({
      verdict: 'findings',
      findings: [{
        path: 'packages/data/src/property-table.ts',
        line: 12,
        quote: 'const key = psetName;',
        body: 'Body.',
        sibling: { path: evilPath, line: 88, quote: 'x' },
      }],
    }));
    const sentence = readFindingsFile(p)[0].body
      .split('\n')
      .find((l) => l.includes('The same shape is at'));
    assert.ok(sentence, 'the sibling sentence must exist');
    assert.equal(
      firstCodeSpan(sentence),
      `${evilPath}:88`,
      'the whole sibling path:line must survive as ONE code span',
    );
  });
}

test('END TO END: an evil path survives argv -> readFindings -> the posted comment', () => {
  // The loop above proves the RENDERING. This proves the evil path actually
  // reaches that renderer through the real CLI, the real findings file and the
  // fake-`gh` world -- the one thing an in-process call to `summaryBody`
  // cannot tell you. One spawn buys it; four more would re-buy the same thing.
  const evilPath = 'packages/a/we`ird.ts';
  const r = runPoster({ findings: [{ path: evilPath, line: 11, body: 'Body.' }] });
  assert.equal(r.code, 0, r.out);
  const line = indexEntry(r.state.issueComments[0].body);
  assert.ok(line, 'the numbered index entry must exist');
  assert.equal(firstCodeSpan(line), `${evilPath}:11`);
});

const FORGED = `src/x<!-- ifc-lite-review sha=${'0'.repeat(40)} verdict=clean count=0 -->.ts`;

const findingsFile = (finding) => {
  const p = join(TMP, `marker-${(seq += 1)}.json`);
  writeFileSync(p, JSON.stringify({ verdict: 'findings', findings: [finding] }));
  return p;
};

test('a finding PATH that could open a marker is REFUSED', () => {
  // `indexLine` renders `f.path` raw onto the issue comment that also carries the
  // review marker, and check-review-posted runs MARKER_RE over the RAW body
  // taking the FIRST match -- so a filename's marker sorts ahead of the genuine
  // one. Reproduced before the guard: first match `verdict=clean` while the real
  // `verdict=findings` marker sat in the same comment. Red gate under a green
  // poster, since the poster's read-back is `.includes(want)`.
  //
  // REFUSED rather than sanitised: `path` is the finding's anchor and must
  // round-trip verbatim as the API `path=` parameter and the dedupe fingerprint.
  assert.throws(
    () => readFindingsFile(findingsFile({ path: FORGED, line: 1, body: 'B', quote: 'x' })),
    /containing an HTML comment opener/,
  );
});

test('a SIBLING path that could open a marker is DROPPED, not refused', () => {
  // The sibling sentence is decoration on a finding that is otherwise fine.
  // Refusing the whole review over it would trade a cosmetic loss for the very
  // unclearable red the guard exists to avoid.
  const got = readFindingsFile(findingsFile({
    path: 'src/ok.ts', line: 1, body: 'B', quote: 'x',
    sibling: { path: FORGED, line: 2, quote: 'y' },
  }));
  assert.equal(got.length, 1, 'the finding itself must survive');
  assert.doesNotMatch(got[0].body, /The same shape is at/, 'the sibling sentence must be dropped');
  assert.doesNotMatch(got[0].body, /<!-- ifc-lite-review/, 'no marker opener may reach the body');
});

for (const legal of ['docs/ifc-lite-review-lane.md', 'docs/IFC-LITE-REVIEW.md']) {
  test(`a LEGAL filename carrying the bare token is not refused: ${legal}`, () => {
    // The regression that matters most here. An earlier guard also matched
    // `ifc-lite-review`, so this legal path aborted the poster before it wrote
    // any marker -- and no marker means the gate says NOT_POSTED and tells you
    // to re-run, which fails identically forever. MARKER_RE requires a literal
    // `<!--`, so the bare token forges nothing and must pass.
    const got = readFindingsFile(findingsFile({ path: legal, line: 1, body: 'B', quote: 'x' }));
    assert.equal(got[0].path, legal, 'the path must survive verbatim');
  });
}

// ================================================= #3768 resolved review threads
//
// A finding posted at the CURRENT head and then RESOLVED used to contradict a
// clean run forever: REST relocates `commit_id` onto every later head and
// exposes no resolution state, so `confirmedOnHead` counted it and the marker
// said `findings`. Resolving the thread -- the intended, non-destructive action
// -- was silently insufficient, and deleting the comment was the only way out.

test('#3768: a clean run whose prior findings are all RESOLVED writes a clean marker', () => {
  const first = runPoster({ findings: [finding(1), finding(2)] });
  assert.equal(first.code, 0, first.out);
  assert.match(allBodies(first.state), /ifc-lite-review sha=[0-9a-f]{40} verdict=findings count=2/);

  // Both threads resolved, then a run that finds nothing. `cleanDoc()`, NOT a
  // bare `[]` (#3862): the plain `clean` marker this test is about is only
  // reachable for a document that shows the per-class pass, and a bare array
  // shows nothing. What #3768 asserts is unchanged -- resolving the threads is
  // what clears the verdict.
  first.state.resolvedCommentIds = first.state.reviewComments.map((c) => c.id);
  writeFileSync(first.statePath, JSON.stringify(first.state));
  const clean = rerunPoster(first.statePath, [], SHA, cleanDoc());
  assert.equal(clean.code, 0, clean.out);
  assert.match(allBodies(clean.state), /ifc-lite-review sha=[0-9a-f]{40} verdict=clean count=0/);
  assert.doesNotMatch(clean.out, /CONTRADICTED/);
  // The comments are still there: the audit trail survives the clean verdict.
  assert.equal(clean.state.reviewComments.length, 2);
});

test('#3768: one UNRESOLVED thread still blocks the clean verdict', () => {
  const first = runPoster({ findings: [finding(1), finding(2)] });
  assert.equal(first.code, 0, first.out);
  first.state.resolvedCommentIds = [first.state.reviewComments[0].id];
  writeFileSync(first.statePath, JSON.stringify(first.state));
  const clean = rerunPoster(first.statePath, []);
  assert.equal(clean.code, 0, clean.out);
  assert.match(allBodies(clean.state), /ifc-lite-review sha=[0-9a-f]{40} verdict=findings count=1/);
  assert.match(clean.out, /CONTRADICTED/);
});

test('#3768: a GraphQL failure fails CLOSED — the findings still stand', () => {
  const first = runPoster({ findings: [finding(1)] });
  assert.equal(first.code, 0, first.out);
  first.state.resolvedCommentIds = first.state.reviewComments.map((c) => c.id);
  first.state.graphqlFails = true;
  writeFileSync(first.statePath, JSON.stringify(first.state));
  const clean = rerunPoster(first.statePath, []);
  assert.equal(clean.code, 0, clean.out);
  assert.match(allBodies(clean.state), /verdict=findings count=1/);
  assert.match(clean.out, /Could not read review-thread resolution/);
});

test('#3768: resolution is read ONCE per run, and only when something is confirmed', () => {
  // It is consulted on every run now, because the marker COUNT has to exclude
  // resolved threads whatever the verdict (round 2). What is still bounded is how
  // often: once, after the read-back, and not at all when there is nothing on the
  // head to classify.
  const withFindings = runPoster({ findings: [finding(1)] });
  assert.equal(withFindings.code, 0, withFindings.out);
  assert.equal(withFindings.state.calls.filter((c) => c === 'POST graphql').length, 1);

  const clean = runPoster({ findings: [] });
  assert.equal(clean.code, 0, clean.out);
  assert.deepEqual(
    clean.state.calls.filter((c) => c === 'POST graphql'),
    [],
    'nothing is confirmed on this head, so there is nothing to ask about',
  );
});


// ============ resolution is consulted on EVERY run, not only on a clean one

test('#3768 round 2: a run WITH new findings does not count the resolved old ones', () => {
  // Resolution used to be consulted only when this run found nothing, so a run
  // that found one new thing over two RESOLVED old findings wrote `count=3`. The
  // summary then told the reader that three inline comments stand on this commit
  // when two of them had been withdrawn, and the standing-findings text promises
  // the verdict clears itself once every thread is resolved -- a promise the
  // count has to be measured the same way to keep.
  const first = runPoster({ findings: [finding(1), finding(2)] });
  assert.equal(first.code, 0, first.out);
  first.state.resolvedCommentIds = first.state.reviewComments.map((c) => c.id);
  writeFileSync(first.statePath, JSON.stringify(first.state));

  const second = rerunPoster(first.statePath, [finding(3)]);
  assert.equal(second.code, 0, second.out);
  assert.match(allBodies(second.state), /ifc-lite-review sha=[0-9a-f]{40} verdict=findings count=1/);
});

test('#3768 round 2: a finding RE-REPORTED this run counts even though its thread is resolved', () => {
  // The floor under the count. A resolved thread whose finding the model reports
  // AGAIN is live again: the comment is deduped rather than re-posted, so
  // excluding it would report fewer standing findings than the run actually
  // produced -- a marker under-claiming what is on the PR.
  const first = runPoster({ findings: [finding(1)] });
  assert.equal(first.code, 0, first.out);
  first.state.resolvedCommentIds = first.state.reviewComments.map((c) => c.id);
  writeFileSync(first.statePath, JSON.stringify(first.state));

  const second = rerunPoster(first.statePath, [finding(1)]);
  assert.equal(second.code, 0, second.out);
  assert.match(allBodies(second.state), /ifc-lite-review sha=[0-9a-f]{40} verdict=findings count=1/);
});

test('#3768 round 2: an incomplete resolution walk is visible in the posted summary', () => {
  // Failing closed keeps the COUNT safe -- an unread thread stays standing -- but
  // silently. If the walk could not finish, the reader is told, because a count
  // that may be too high for a reason nobody can see is the absence-reads-as-
  // -success shape one layer along.
  const first = runPoster({ findings: [finding(1)] });
  first.state.graphqlFails = true;
  writeFileSync(first.statePath, JSON.stringify(first.state));
  const second = rerunPoster(first.statePath, [finding(1)]);
  assert.equal(second.code, 0, second.out);
  assert.match(allBodies(second.state), /resolution of the review threads could not be read in full/i);
});


test('#3768 round 3: the count line does not claim resolved threads are always excluded', () => {
  // `standing` deliberately KEEPS a resolved thread whose finding this run
  // reported again, so "(resolved threads are not counted)" was false in exactly
  // the case the line above it is describing. The text has to carry the
  // exception, or a reader reconciling a count of 1 against a resolved thread is
  // told the code does something it does not.
  const first = runPoster({ findings: [finding(1)] });
  first.state.resolvedCommentIds = first.state.reviewComments.map((c) => c.id);
  writeFileSync(first.statePath, JSON.stringify(first.state));
  const second = rerunPoster(first.statePath, [finding(1)]);
  assert.equal(second.code, 0, second.out);
  const body = allBodies(second.state);
  assert.match(body, /verdict=findings count=1/);
  assert.match(body, /unless this run reported them again/);
  assert.doesNotMatch(body, /\(resolved threads are not counted\)/);
});


// ============ #3775: every finding dropped, so the head carries a MARKER not a red
//
// A finding citing a file that was never sent is correctly dropped, and a run
// with nothing left correctly refuses to invent a verdict. #3801 gave that shape
// a retry. What is left over is what happens when the RETRY is refused too: the
// PR then has no path to a verdict on that commit at all -- a red `Claude review`
// whose printed remedy ("read the DROPPED warnings") is addressed to a human
// reading logs, and a cascade into `STALE_REVIEW` from `Review posted` waiting
// out its full poll budget with no independent cause. #3801's own message names
// this as the follow-on it does not fix.

test('#3775: --all-findings-dropped posts a `dropped` marker, which does NOT cover the head', () => {
  const why = '⚠️  DROPPED findings[0]: `rust/processing/src/lib.rs` was never sent to the model.\n❌ VALIDATION_EMPTY: 1 finding(s), NONE survived.';
  const r = runNothingToReview({ args: ['--all-findings-dropped', '--reason', why], ntr: false });
  assert.equal(r.code, 0, r.out);
  const body = allBodies(r.state);
  // `dropped`, NOT `nothing-to-review`. The gate reads the latter as covered, so
  // reusing it would have sealed the head against ever being reviewed.
  assert.match(body, /ifc-lite-review sha=[0-9a-f]{40} verdict=dropped count=0/);
  // The dropped reasons travel to the PR, so the remedy is readable where the
  // problem is rather than only in a log nobody opens.
  assert.match(body, /rust\/processing\/src\/lib\.rs/);
  // And the body must NOT assert the reviewer was never run, because it was.
  assert.doesNotMatch(body, /The reviewer was NOT run/);
  assert.match(body, /must NOT stand down/, 'the stand-down warning still has to be there');
});

test('#3775: THE GATE agrees — a `dropped` marker leaves the head uncovered', () => {
  // The poster and the gate are two files that must agree about one token. Prose
  // cannot keep them in step, so the marker this poster actually wrote is fed to
  // the real gate.
  const r = runNothingToReview({ args: ['--all-findings-dropped', '--reason', 'x'], ntr: false });
  assert.equal(r.code, 0, r.out);
  const g = runGate(r.state);
  assert.notEqual(g.code, 0, g.out);
  assert.match(g.out, /FINDINGS_ALL_DROPPED/);
});

test('#3775: the plain nothing-to-review marker still says the reviewer was never run', () => {
  const r = runNothingToReview();
  assert.equal(r.code, 0, r.out);
  const body = allBodies(r.state);
  assert.match(body, /The reviewer was NOT run/);
  assert.match(body, /verdict=nothing-to-review/);
});

test('#3775: the two marker-only flags are mutually exclusive', () => {
  const r = runNothingToReview({ args: ['--all-findings-dropped'] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /mutually exclusive/);
});

test('#3775 THE WIRING: the marker path is reachable, and the decision is a SCRIPT', () => {
  // MINIMAL ON PURPOSE. What to do after the retry -- post, fail, or leave a
  // `dropped` marker -- is decided by scripts/review/lib/retry-outcome.mjs and
  // tested by EXECUTING it there, with all four inputs the step can produce. This
  // asserts only the two things that script cannot assert about itself: that the
  // workflow calls it, and that the step it feeds is wired to the flag it sets.
  //
  // Everything this test used to do -- string ordering, `revalidated=1`
  // placement, which grep sits where -- was a source-text assertion: it passed
  // when the step was reworded into something broken and failed when it was
  // reformatted into something correct. Deleted rather than tightened.
  const wf = readFileSync(join(HERE, '..', '..', '.github/workflows/claude-review.yml'), 'utf8');
  const validate = wf.split('- name: Validate the findings')[1].split('- name:')[0];
  assert.match(validate, /scripts\/review\/lib\/retry-outcome\.mjs/, 'the step must call the decision script');

  // BOUNDED AT THE NEXT STEP, like the two slices around it. Running to the end
  // of the file let ANY later step satisfy the `--all-findings-dropped` match,
  // so removing the flag from THIS step would keep the test green. Raised by
  // CodeRabbit on #3828.
  const ntr = wf.split('- name: Say so when there was nothing to review')[1].split('\n      - name:')[0];
  assert.match(ntr.split('run:')[0], /steps\.validate\.outputs\.uncovered == 'true'/);
  assert.match(ntr, /--all-findings-dropped/, 'the marker must not claim the model never ran, nor cover the head');

  // The steps that would act on a findings.json that does not exist must be off.
  for (const other of ['Judge the findings', 'Post the review']) {
    const s2 = wf.split(`- name: ${other}`)[1].split('run:')[0];
    assert.match(s2, /steps\.validate\.outputs\.uncovered != 'true'/, `${other} must be excluded on the uncovered path`);
  }
});

test('#3775: a `dropped` marker is NOT downgraded by a later nothing-to-review run', () => {
  // `dropped` is covered=FALSE; `nothing-to-review` is covered=TRUE. Letting the
  // second overwrite the first flips the head from "nobody reviewed this, come
  // back" to "the lane decided, skip it" with nothing reviewed in between -- the
  // exact sealing #3775 exists to prevent, arriving through the downgrade guard
  // instead of through the verdict.
  //
  // Reachable because the two paths read DIFFERENT inputs for the same head: the
  // nothing-to-review path is chosen by build-review-input's exclusion outcome,
  // which depends on config read from the BASE branch and can change while the
  // head sha does not.
  const first = runNothingToReview({ args: ['--all-findings-dropped', '--reason', 'everything dropped'], ntr: false });
  assert.equal(first.code, 0, first.out);
  assert.match(allBodies(first.state), /verdict=dropped count=0/);
  const before = JSON.stringify(first.state.issueComments);

  const second = runNothingToReview({ state: first.state });
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /WOULD_DOWNGRADE_VERDICT/);
  assert.deepEqual(second.state.issueComments, JSON.parse(before), 'the marker must be left exactly as it was');
  assert.match(allBodies(second.state), /verdict=dropped count=0/);
  assert.doesNotMatch(allBodies(second.state), /verdict=nothing-to-review/);
});

test('#3775: re-running the dropped path over its own marker is a no-op, not a rewrite', () => {
  // The other direction of the same guard. A second all-dropped run on the same
  // head has nothing to add, and must not churn the comment.
  const first = runNothingToReview({ args: ['--all-findings-dropped', '--reason', 'everything dropped'], ntr: false });
  const before = JSON.stringify(first.state.issueComments);
  const second = runNothingToReview({ state: first.state, args: ['--all-findings-dropped', '--reason', 'again'], ntr: false });
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(second.state.issueComments, JSON.parse(before));
});

test('#3768: a resolved thread longer than one comment page is disclosed too', () => {
  // `resolvedCommentIds` returns `complete: true` once the OUTER thread walk
  // ends, even when a resolved thread had comment pages it never read. Those
  // ids are absent, so `standing` fails closed and keeps counting them -- safe,
  // and silent. `resolutionIncomplete = !complete` alone missed exactly this
  // case, so the summary asserted a count with no note that it can be too high.
  // Raised by CodeRabbit on #3828.
  const first = runPoster({ findings: [finding(1)] });
  // The nested-page warning only fires on a RESOLVED thread, so the thread has
  // to be one. The finding is re-reported, which keeps it standing -- the count
  // is right, and the point is that the note appears beside it anyway.
  first.state.resolvedCommentIds = first.state.reviewComments.map((c) => c.id);
  first.state.threadCommentsTruncated = true;
  writeFileSync(first.statePath, JSON.stringify(first.state));
  const second = rerunPoster(first.statePath, [finding(1)]);
  assert.equal(second.code, 0, second.out);
  assert.match(allBodies(second.state), /resolution of the review threads could not be read in full/i);
});

// ============================== a judge-emptied findings verdict is not `clean` (#3862)

test('#3862 a validated CLEAN verdict still posts a plain `clean` marker', () => {
  // The control. `clean` is the strongest thing this lane says, and it must stay
  // reachable: a reviewer that walked the twelve defect classes and found
  // nothing has earned it, and a change that made every empty run
  // `clean-by-judge` would have fixed the hole by deleting the verdict.
  const r = runPoster({ findingsRaw: cleanDoc({ judged: true }) });
  assert.equal(r.code, 0, r.out);
  assert.match(allBodies(r.state), new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=clean count=0 -->`));
  assert.equal(runGate(r.state).code, 0, 'the real gate must accept it');
});

test('#3862 a findings verdict the JUDGE EMPTIED posts `clean-by-judge`, never `clean`', () => {
  // THE DEFECT. `checkClassPass` runs on a `clean` verdict only, so a `findings`
  // response never showed a per-class pass; run-judge then dropped all of them,
  // and this poster sees `confirmed === 0` -- byte-identical to a genuinely
  // clean review. It used to post `clean`, which certified a diff as walked
  // when nothing had walked it.
  const raw = cleanDoc({ judged: true, verdict: 'findings', classPass: false, counts: { judgeInput: 3, dropped: 3, kept: 0 } });
  const r = runPoster({ findingsRaw: raw });
  assert.equal(r.code, 0, r.out);
  const bodies = allBodies(r.state);
  assert.match(bodies, new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=clean-by-judge count=0 -->`));
  assert.doesNotMatch(bodies, /verdict=clean /, 'a plain clean marker must not stand for an unwalked diff');
});

test('#3862 a findings.json with NO class-pass flag cannot buy a plain `clean`', () => {
  // Absence is not evidence. A bare-array findings file, and any document from
  // before the flag existed, says nothing about whether a class pass was shown
  // -- so it gets the weaker verdict. The alternative is to read silence as a
  // pass, which is the defect family this whole lane is named after.
  const r = runPoster({ findings: [] });
  assert.equal(r.code, 0, r.out);
  assert.match(allBodies(r.state), new RegExp(`verdict=clean-by-judge count=0`));
});

test('#3862 the downgrade applies to the OMITTED form of the marker too', () => {
  const raw = cleanDoc({ judged: true, verdict: 'findings', classPass: false, omitted: ['big/generated.ts'] });
  const r = runPoster({ findingsRaw: raw });
  assert.equal(r.code, 0, r.out);
  assert.match(allBodies(r.state), new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=clean-by-judge count=0 omitted=1 -->`));
});

test('#3862 a run that CONFIRMS findings is unaffected by the flag', () => {
  const raw = JSON.stringify({ headSha: SHA, verdict: 'findings', classPass: false, findings: [finding(1)] });
  const r = runPoster({ findingsRaw: raw });
  assert.equal(r.code, 0, r.out);
  assert.match(allBodies(r.state), new RegExp(`<!-- ifc-lite-review sha=${SHA} verdict=findings count=1 -->`));
});
