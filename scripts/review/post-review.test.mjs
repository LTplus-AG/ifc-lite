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
import { readFindings, MAX_POSTED_FINDINGS, summaryBody, readJudgedAway, readCappedCount } from './post-review.mjs';
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
function runNothingToReview({ state = {}, sha = SHA, args = [], author = REVIEWER } = {}) {
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
    [SCRIPT, '--pr', PR, '--repo', REPO, '--sha', sha, '--nothing-to-review', '--author', author, ...args],
    { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FAKE_GH_STATE: statePath } },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}`, state: JSON.parse(readFileSync(statePath, 'utf8')) };
}

/** Re-run the poster against a world a previous run left behind. */
function rerunPoster(statePath, findings, sha = SHA) {
  const fPath = join(TMP, `findings-rerun-${(seq += 1)}.json`);
  writeFileSync(fPath, JSON.stringify(findings));
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
  const r = runPoster({ findings: [] });
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
    assert.equal(c.commit_id, SHA, 'a finding not anchored to this head is invisible to the gate');
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
  const r = runPoster({ findings: [] });
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
  assert.match(body, /3 inline comments from this reviewer confirmed on this commit\./);
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
  const seed = (id, path, line) => ({ id, user: { login: REVIEWER }, commit_id: SHA, path, line, side: 'RIGHT', body });

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

test('FAIL: a clean verdict over our OWN findings on this head is refused', () => {
  const seeded = {
    id: 901,
    user: { login: REVIEWER },
    commit_id: SHA,
    path: 'packages/a/src/x.ts',
    line: 3,
    side: 'RIGHT',
    body: 'An earlier run of this same head found this.',
  };
  const r = runPoster({ findings: [], state: { reviewComments: [seeded] } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /CLEAN_CONTRADICTED/);
  assert.doesNotMatch(allBodies(r.state), /verdict=clean/, 'a clean marker must not bury a live finding');
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
  const got = readFindings(p);
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
  assert.equal(readFindings(p).length, MAX_POSTED_FINDINGS);
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
  assert.equal(readFindings(p).length, MAX_POSTED_FINDINGS);
});

test('a review the judge emptied does NOT read as a review that found nothing', () => {
  // The judge can reject every validated finding. Without this the PR shows
  // "found nothing to flag" and the only record that they existed is a runner
  // log that expires -- absence reading as success, on a path the judge created.
  const plain = summaryBody({ sha: 'a'.repeat(40), findings: [], count: 0 });
  assert.match(plain, /found nothing to flag/);
  assert.doesNotMatch(plain, /dropped as too vague/, 'a genuinely clean review must not claim drops');

  const judged = summaryBody({ sha: 'a'.repeat(40), findings: [], count: 0, judgedAway: 4 });
  assert.match(judged, /4 finding\(s\) were written and then dropped/);
  assert.match(judged, /ifc-lite-review sha=/, 'the marker must still be written');
});

test('readJudgedAway returns 0 for anything unreadable, and never throws', () => {
  // It decorates a message. A malformed count must never be why a review fails
  // to post -- that would trade a cosmetic line for a missing marker.
  const bad = join(TMP, 'judged-bad.json');
  writeFileSync(bad, 'not json at all');
  assert.equal(readJudgedAway(bad), 0);
  assert.equal(readJudgedAway(join(TMP, 'does-not-exist.json')), 0);

  // `judged: true` REQUIRED, and this test asserted the opposite by omission.
  // `counts.dropped` means "the judge rejected these" in judged.json and
  // "the validator refused these as malformed" in findings.json, which the
  // workflow's crash backstop copies verbatim. Without the flag the poster told
  // the author N findings were "dropped as too vague" about findings that had
  // actually quoted a line not in the diff.
  const good = join(TMP, 'judged-good.json');
  writeFileSync(good, JSON.stringify({ judged: true, findings: [], counts: { dropped: 3 } }));
  assert.equal(readJudgedAway(good), 3);

  const unjudged = join(TMP, 'judged-fallback.json');
  writeFileSync(unjudged, JSON.stringify({ findings: [], counts: { dropped: 3 } }));
  assert.equal(readJudgedAway(unjudged), 0, 'the validator\'s own drops are not judge drops');
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
  const got = readFindings(p);
  assert.match(got[0].body, /packages\/cache\/src\/sections\/properties\.ts:88/, 'the twin must be named');
  assert.match(got[0].body, /this PR does not change/);
});

test('a finding with no sibling gains no stray sentence', () => {
  const p = join(TMP, 'nosibling.json');
  writeFileSync(p, JSON.stringify({
    verdict: 'findings',
    findings: [{ path: 'packages/a/f.ts', line: 1, quote: 'q', body: 'A plain finding.' }],
  }));
  assert.doesNotMatch(readFindings(p)[0].body, /same shape is at/);
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
  const p = join(TMP, 'capcount.json');
  writeFileSync(p, JSON.stringify({ findings: Array.from({ length: 9 }, () => ({})) }));
  assert.equal(readCappedCount(p, 5), 4);
  assert.equal(readCappedCount(p, 9), 0, 'nothing withheld when all were shown');
  assert.equal(readCappedCount(join(TMP, 'no-such-file.json'), 5), 0);
  writeFileSync(join(TMP, 'capbad.json'), 'not json');
  assert.equal(readCappedCount(join(TMP, 'capbad.json'), 5), 0);
});
