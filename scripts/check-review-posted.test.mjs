/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gate is driven as a PROCESS -- real argv, real config reads, real exit
 * codes -- because that is what CI runs. `--state-file` stands in for the two
 * `gh` reads, so every branch is reachable without a network, a token, or a real
 * PR, and the parser and the policy under test are the shipped ones.
 *
 * Both directions for every verdict. A gate that has only been seen to pass has
 * not been seen to work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageAll, evaluate, shouldKeepPolling } from './check-review-posted.mjs';
import {
  REVIEW_LANE_TIMEOUT_SECONDS,
  REVIEW_POSTED_JOB_TIMEOUT_SECONDS,
  REVIEW_POSTED_MINIMUM_GRACE_SECONDS,
  REVIEW_POSTED_POLL_SECONDS,
  assertReviewLaneBudget,
  pollSecondsArgument,
} from './review-lane-budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'check-review-posted.mjs');
const CONFIG = join(HERE, 'review-posted.config.json');
const SHIPPED = JSON.parse(readFileSync(CONFIG, 'utf8'));

const TMP = mkdtempSync(join(tmpdir(), 'review-posted-'));
let seq = 0;

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const REVIEWER = 'github-actions';
const STRANGER = 'someone-else';

const marker = (sha, verdict = 'clean', count = 0) =>
  `<!-- ifc-lite-review sha=${sha} verdict=${verdict} count=${count} -->`;

/** Write a config variant. Defaults to `enforcing`: a verdict test asks about POLICY, and the shipped `mode` is a rollout state that will flip. */
function cfgWith(patch, tag) {
  const path = join(TMP, `cfg-${tag}.json`);
  writeFileSync(path, JSON.stringify({ ...SHIPPED, mode: 'enforcing', ...patch }));
  return ['--config', path];
}
const ENFORCING = cfgWith({}, 'enforcing-base');

/** Run the gate over a payload exactly as written. */
/**
 * `headRepo` IS DEFAULTED HERE, and it is not cosmetic.
 *
 * The fork carve-out reads `head.repo.full_name` from the API when the payload
 * does not carry one. Without this default every enforcement test made a live
 * `gh api` call, and in CI the "Unit-test the gate itself" step has NO GH_TOKEN
 * -- so `gh` refused, the gate exited 1, and every `assert.equal(r.code, 1)`
 * passed on a CREDENTIAL ERROR rather than on enforcement. A regression turning
 * `process.exit(ok ? 0 : 1)` into `exit(0)` would have been invisible. Caught in
 * review; measured at 13 unstubbed calls in this file and 1 in post-review's.
 *
 * `--repo` travels with it: without one `args.repo` is null, and a defaulted
 * `headRepo` would then read as a FORK and excuse every failing verdict.
 * A payload that sets `headRepo` explicitly still overrides this, which is what
 * keeps the fork and NO_HEAD_REPO cases reachable.
 */
const SAME_REPO = 'LTplus-AG/ifc-lite';

function run(payload, extra = [...ENFORCING], sha = SHA) {
  const path = join(TMP, `payload-${(seq += 1)}.json`);
  writeFileSync(path, JSON.stringify({ headRepo: SAME_REPO, ...payload }));
  const r = spawnSync(process.execPath, [GATE, '--pr', '1', '--sha', sha, '--repo', SAME_REPO, '--state-file', path, ...extra], {
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const comments = (...cs) => ({ issueComments: cs.map(([user, body]) => ({ user: { login: user }, body })) });

/**
 * Inline review comments, which is the surface a FINDING lives on and the one
 * #1679 drops.
 *
 * TWO ANCHORS, NOT ONE (#3729). `writtenAt` is `original_commit_id`, which is
 * frozen and is what the gate counts; `claims` is `commit_id`, which GitHub
 * relocates onto a later head and which the gate must ignore. They default to
 * the same value because that is what a freshly posted row looks like; a test
 * that means to model a relocated row passes them apart.
 */
const inline = (...cs) => ({
  reviewComments: cs.map(([user, body, writtenAt = SHA, claims = writtenAt]) => ({
    user: { login: user },
    body,
    commit_id: claims,
    original_commit_id: writtenAt,
  })),
});

/** A degraded-review marker (#3679): `omitted=<n>` on an otherwise clean verdict. */
const partialMarker = (n) => `Partial.\n<!-- ifc-lite-review sha=${SHA} verdict=clean count=0 omitted=${n} -->`;

/**
 * Run the gate with a GITHUB_OUTPUT file and return what it WROTE there as well
 * as what it printed. `covered` and `full` exist only on that surface -- the
 * workflows read them and nothing else does -- so a test that reads only stdout
 * cannot see the values the whole mechanism turns on.
 */
function runOut(payload, extra = [...ENFORCING], sha = SHA) {
  const ghPath = join(TMP, `ghout-${(seq += 1)}.txt`);
  const payloadPath = join(TMP, `p-out-${seq}.json`);
  writeFileSync(ghPath, '');
  writeFileSync(payloadPath, JSON.stringify({ headRepo: SAME_REPO, ...payload }));
  const r = spawnSync(
    process.execPath,
    [GATE, '--pr', '1', '--sha', sha, '--repo', SAME_REPO, '--state-file', payloadPath, ...extra],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: ghPath } },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}`, gh: readFileSync(ghPath, 'utf8') };
}

// ============================================================ the core verdicts

test('a marker carrying `omitted=N` parses, passes, and NAMES the partial (#3679)', () => {
  // A degraded review posts `omitted=<n>` so a partial review can never read as
  // a full one at this surface. Parsing it here is backward-compatible on
  // purpose: the field is optional in MARKER_RE, so every pre-#3679 marker
  // still parses (the test above this one is that proof).
  const r = run(comments([REVIEWER, `Partial.\n<!-- ifc-lite-review sha=${SHA} verdict=clean count=0 omitted=3 -->`]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /REVIEW_POSTED/);
  assert.match(r.out, /PARTIAL: 3 changed file\(s\)/);
  assert.match(r.out, /NOT shown to the reviewer/);
});

test('a PARTIAL head reports full=false, so the stand-down cannot cover the omitted files', () => {
  // The gate prints "N file(s) ... NOT reviewed" and then hands the workflow the
  // value review-posted.yml turns into `llm-reviewed`, which is what CodeRabbit
  // reads to stay off the PR. With `full=true` here the omitted files would get
  // no model review AND no CodeRabbit review, on the very head the gate just
  // said nothing vouches for. Same reasoning that already sets full=false for
  // `nothing-to-review`. Raised by CodeRabbit on PR #3688.
  const out = runOut(comments([REVIEWER, partialMarker(3)]));
  // NOT a red: a degraded review is a partly-uncovered head, not a failing lane.
  assert.equal(out.code, 0, out.out);
  assert.match(out.gh, /full=false/, 'nothing read the omitted files');
  assert.match(out.out, /FULL=FALSE/);
  // The partial class names a remedy, and the remedy does not contradict it.
  assert.match(out.out, /REMEDY: split the PR/);
});

test('a PARTIAL head still reports covered=true, or every re-trigger re-reviews it', () => {
  // `covered` is claude-review.yml's DEDUP key: `steps.dedup.outputs.covered`
  // gates every later step of that job, so covered=false means the next
  // synchronize/re-run event re-runs the model over the files that DID fit and
  // posts their inline comments a second time. The first attempt at the test
  // above asserted covered=false and bought the stand-down fix with duplicate
  // reviews. The two questions are two outputs.
  const out = runOut(comments([REVIEWER, partialMarker(3)]));
  assert.equal(out.code, 0, out.out);
  assert.match(out.gh, /covered=true/, 'a verdict exists for this head');
  assert.match(out.out, /COVERED stays true/);
});

test('the anti-vacuity pair: the SAME marker without `omitted` reports full=true', () => {
  // Without this, the tests above would pass just as well if `full` were false
  // for every verdict -- i.e. with the stand-down mechanism entirely dead.
  const out = runOut(comments([REVIEWER, `Full.\n<!-- ifc-lite-review sha=${SHA} verdict=clean count=0 omitted=0 -->`]));
  assert.equal(out.code, 0, out.out);
  assert.match(out.gh, /full=true/);
  assert.match(out.gh, /covered=true/);
  assert.doesNotMatch(out.out, /PARTIAL:/);
});

test('a marker WITHOUT `omitted` prints no partial line', () => {
  // The partial note must fire only when the marker claims an omission; on
  // every full review it would be noise that trains readers to ignore it.
  const r = run(comments([REVIEWER, `Full.\n${marker(SHA)}`]));
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /PARTIAL:/);
});

test('PASS: the expected reviewer posted a marker naming this head', () => {
  const r = run(comments([REVIEWER, `Looks fine.\n${marker(SHA)}`]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /REVIEW_POSTED/);
  assert.match(r.out, /clean verdict/);
});

test('PASS: a findings verdict backed by an INLINE finding on this head', () => {
  const r = run({
    ...comments([REVIEWER, `Summary.\n${marker(SHA, 'findings', 1)}`]),
    ...inline([REVIEWER, 'This index can be negative.']),
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /findings verdict.*with 1 finding/);
});

test('FAIL: a summary comment from another workflow does not count as a finding', () => {
  // benchmark.yml posts as `github-actions` on any PR touching rust/, packages/,
  // apps/viewer/ or Cargo.*, and that login is an expected reviewer. Counting any
  // non-carrier comment made this check inert on most PRs in this repo.
  const r = run({
    ...comments(
      [REVIEWER, 'Viewer benchmark: 12ms (advisory).'],
      [REVIEWER, `Summary.\n${marker(SHA, 'findings', 3)}`],
    ),
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FINDINGS_NOT_POSTED/);
});

test('FAIL: findings anchored to an EARLIER head do not cover this one', () => {
  const r = run({
    ...comments([REVIEWER, `Summary.\n${marker(SHA, 'findings', 3)}`]),
    ...inline([REVIEWER, 'stale finding', OTHER_SHA]),
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FINDINGS_NOT_POSTED/);
});

test('#3729: a RELOCATED finding reports this head and must NOT cover it', () => {
  // RED BEFORE THE FIX, GREEN AFTER, AND THE TWO INPUTS BELOW DIFFER IN EXACTLY
  // ONE FIELD -- the one the gate used to ignore. GitHub relocates `commit_id`
  // on `pulls/{n}/comments` onto a later head (the measurement and the raw rows
  // are in scripts/lib/review-provenance.mjs), so under the old predicate
  // (`commit_id === headSha`) the first case here PASSED and printed
  // "findings verdict ... with 1 finding": a marker claiming a finding on this
  // head, confirmed by a finding from a tree that no longer exists. That is the
  // #1679 shape wearing the gate's own tick.
  //
  // The pair is one test on purpose. Split, the negative half is satisfied by
  // "reject everything" and the positive half is the pre-existing PASS case
  // above with different literals; together they pin the FIELD.
  const summary = comments([REVIEWER, `Summary.\n${marker(SHA, 'findings', 1)}`]);
  const body = 'a finding from the previous head';

  //                                      written at   claims
  const relocated = run({ ...summary, ...inline([REVIEWER, body, OTHER_SHA, SHA]) });
  assert.equal(relocated.code, 1, relocated.out);
  assert.match(relocated.out, /FINDINGS_NOT_POSTED/);

  const written = run({ ...summary, ...inline([REVIEWER, body, SHA, SHA]) });
  assert.equal(written.code, 0, written.out);
  assert.match(written.out, /findings verdict.*with 1 finding/);
});

test('FAIL CLOSED (#3729): an inline row with no `original_commit_id` refuses', () => {
  // The ONLY frozen provenance on this surface. Absent, there is nothing left
  // that says which commit was read -- and both fallbacks are wrong in a way
  // nobody would see: "treat as not-at-head" silently stops counting real
  // findings, "treat as at-head" restores the bug. All 75 inline comments on
  // this repository's open PRs carry it, so an absent one is a payload change.
  const r = run({
    ...comments([REVIEWER, `Summary.\n${marker(SHA, 'findings', 1)}`]),
    reviewComments: [{ user: { login: REVIEWER }, body: 'x', commit_id: SHA }],
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /UNREADABLE_ANCHOR/);
  assert.doesNotMatch(r.out, /findings verdict/);
});

test('FAIL: a findings verdict with NO finding posted is the #1679 shape', () => {
  // The summary posts, the inline comments drop, the run logs `Posted 0/N`, and
  // the job exits 0. The count in the marker is the reviewer's own claim; this is
  // the check that it is true. Without it the gate cites #1679 as its founding
  // case law and cannot see #1679.
  const r = run(comments([REVIEWER, `Found 3 problems.\n${marker(SHA, 'findings', 3)}`]));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FINDINGS_NOT_POSTED/);
  assert.match(r.out, /Posted 0\/N/);
});

test('FAIL: no comments at all -- the #1679 shape, Posted 0/N with a green job', () => {
  const r = run({ issueComments: [], reviews: [] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT_POSTED/);
  assert.match(r.out, /#1679/);
});

test('FAIL: only a stranger commented', () => {
  const r = run(comments([STRANGER, `nice work\n${marker(SHA)}`]));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT_POSTED/);
});

test('FAIL: the reviewer commented but wrote no marker -- the #1644 partial-run shape', () => {
  const r = run(comments([REVIEWER, 'I started reviewing and then stopped.']));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT_POSTED/);
  assert.match(r.out, /marker is written at the END/);
});

test('FAIL: STALE_REVIEW when the marker names a different commit', () => {
  const r = run(comments([REVIEWER, marker(OTHER_SHA)]));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /STALE_REVIEW/);
  // #3729, AND louistrue's correction to it: the remedy must not be pinned to
  // force-push. The same relocation was observed with no force-push, no rebase
  // and no amend, so a reader told "force-push hazard" would conclude they are
  // unaffected. The gate says the field moves, not what moves it.
  assert.match(r.out, /relocates that field onto a later head \(#3729\), with or without/);
  assert.match(r.out, /a force-push/);
});

test('FAIL: MARKER_MALFORMED is reported separately from absence', () => {
  const r = run(comments([REVIEWER, '<!-- ifc-lite-review sha=nope verdict=clean -->']));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /MARKER_MALFORMED/);
  assert.match(r.out, /marker writer/);
});

// ======================================================= identity normalisation

test('the three spellings of a bot identity all resolve to one entry', () => {
  for (const spelling of ['github-actions', 'github-actions[bot]', 'app/github-actions']) {
    const r = run(comments([spelling, marker(SHA)]));
    assert.equal(r.code, 0, `${spelling}: ${r.out}`);
  }
});

test('normalisation is load-bearing, not covered by listing every spelling', () => {
  // Pinned independently: with the config narrowed to ONE spelling, a differently
  // spelled author must still match. Without normalisation this fails.
  const one = cfgWith({ expectedAuthors: ['claude'] }, 'one-spelling');
  const r = run(comments(['claude[bot]', marker(SHA)]), one);
  assert.equal(r.code, 0, r.out);
});

// ============================================================ fail-closed paths

test('FAIL-CLOSED: an exhausted page budget refuses rather than reporting absence', () => {
  // The bound is now REAL: the fetch pages explicitly and reports which surfaces
  // it could not finish. The previous version applied a length check AFTER
  // `--paginate` had already followed Link headers to exhaustion, so it bounded
  // nothing and turned a fully-read busy PR into a permanent refusal it could
  // never clear.
  const r = run({ issueComments: [], truncated: ['issueComments'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /COMMENTS_TRUNCATED/);
  assert.doesNotMatch(r.out, /NOT_POSTED/);
});

test('FAIL-CLOSED: a payload with no comment lists at all is NO_PAYLOAD, not a pass', () => {
  const r = run({});
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NO_PAYLOAD/);
});

test('FAIL-CLOSED: a non-array comment list is BAD_PAYLOAD', () => {
  const r = run({ issueComments: { nope: true } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /BAD_PAYLOAD/);
});

test('FAIL-CLOSED: a missing --sha refuses rather than deriving one', () => {
  const path = join(TMP, 'p-nosha.json');
  writeFileSync(path, JSON.stringify({ headRepo: SAME_REPO, ...comments([REVIEWER, marker(SHA)]) }));
  const r = spawnSync(process.execPath, [GATE, '--pr', '1', '--repo', SAME_REPO, '--state-file', path, ...ENFORCING], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /NO_SHA/);
});

test('FAIL-CLOSED: a short or non-hex --sha is refused', () => {
  const r = run(comments([REVIEWER, marker(SHA)]), [...ENFORCING], 'abc123');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NO_SHA/);
});

test('an unknown flag that exists on Object.prototype is refused', () => {
  // `{...}[name]` reached Object.prototype, so `--constructor x` returned a
  // truthy key, sailed past the `!key` guard, and wrote a junk property instead
  // of refusing. A guard that does not guard what it claims is the failure this
  // whole file is about, one level down.
  const r = spawnSync(
    process.execPath,
    [GATE, '--pr', '1', '--sha', SHA, '--constructor', 'x', '--state-file', '/dev/null'],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /BAD_ARGS.*constructor/);
});

test('a MISSING config and an UNREADABLE one are different verdicts', () => {
  // Different remedies: create the file, versus fix its permissions. Collapsing
  // them into one would point half the readers at the wrong fix.
  const missing = spawnSync(
    process.execPath,
    [GATE, '--pr', '1', '--sha', SHA, '--state-file', '/dev/null', '--config', '/nope/absent.json'],
    { encoding: 'utf8' },
  );
  assert.equal(missing.status, 1);
  assert.match(`${missing.stdout}${missing.stderr}`, /NO_CONFIG/);

  const bad = join(TMP, 'cfg-not-json.json');
  writeFileSync(bad, '{ not json');
  const r = run(comments([REVIEWER, marker(SHA)]), ['--config', bad]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /BAD_CONFIG/);
});

test('a NaN timeout is refused, because NaN never expires a deadline', () => {
  // `Date.now() < deadline` is FALSE forever when deadline is NaN, so the poll
  // would exit immediately -- or, with the comparison the other way, run until
  // the job is killed. Either way a coerced NaN silently changes what the gate
  // does. This repo has the same lesson recorded for numeric config generally:
  // bound both ends rather than trusting the value.
  for (const bad of ['nope', '', '-5']) {
    const r = spawnSync(
      process.execPath,
      [GATE, '--pr', '1', '--sha', SHA, '--state-file', '/dev/null', '--timeout-seconds', bad, ...ENFORCING],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 1, `${JSON.stringify(bad)} should be refused`);
    assert.match(`${r.stdout}${r.stderr}`, /BAD_ARGS/);
  }
});

// ======================================================================= pager

test('the pager walks pages and reports a complete read', () => {
  const pages = { 1: Array(100).fill({ x: 1 }), 2: Array(7).fill({ x: 2 }) };
  const seen = [];
  const r = pageAll((page) => { seen.push(page); return pages[page] ?? []; });
  assert.deepEqual(seen, [1, 2], 'stops at the first short page');
  assert.equal(r.rows.length, 107);
  assert.equal(r.truncated, false);
});

test('an exactly-full LAST page is a complete read, not a truncated one', () => {
  // The previous shape called this truncated, which turned a fully-read surface
  // into a permanent refusal nobody could clear -- the same defect the pager
  // rewrite claimed to remove, at a different boundary.
  const r = pageAll((page) => (page <= 3 ? Array(10).fill({}) : []), { maxPages: 3, perPage: 10 });
  assert.equal(r.rows.length, 30);
  assert.equal(r.truncated, false, 'the probe past the last page came back empty');
});

test('a surface with MORE than the budget reports truncated', () => {
  const r = pageAll(() => Array(10).fill({}), { maxPages: 3, perPage: 10 });
  assert.equal(r.truncated, true, 'the probe found more, so the read is incomplete');
});

test('a non-array page is BAD_PAYLOAD, not an empty read', () => {
  assert.throws(() => pageAll(() => ({ nope: true })), (e) => e.reason === 'BAD_PAYLOAD');
});

// =================================================================== the config

test('an EMPTY expectedAuthors list is refused, not treated as "anyone"', () => {
  const r = run(comments([STRANGER, marker(SHA)]), cfgWith({ expectedAuthors: [] }, 'empty-authors'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /BAD_CONFIG/);
  assert.match(r.out, /every PR pass on any comment/);
});

test('a config that is null or an array is BAD_CONFIG, not a TypeError', () => {
  // Reaching for `.expectedAuthors` on null throws past this file's catch and
  // prints a stack trace instead of the remedy the config is written to give.
  for (const body of ['null', '[]', '"a string"']) {
    const path = join(TMP, `cfg-shape-${(seq += 1)}.json`);
    writeFileSync(path, body);
    const r = run(comments([REVIEWER, marker(SHA)]), ['--config', path]);
    assert.equal(r.code, 1, `${body}: ${r.out}`);
    assert.match(r.out, /BAD_CONFIG/, `${body} must be a classified refusal`);
    // Asserting on a STACK FRAME, not on the word "TypeError": the BAD_CONFIG
    // message deliberately explains what would otherwise be thrown, so matching
    // the word matched this gate's own prose and failed on a correct run.
    assert.doesNotMatch(r.out, /\n\s+at [A-Za-z]/, `${body} must not print a stack trace`);
  }
});

test('a MISSING mode is refused, not defaulted to the lenient one', () => {
  const path = join(TMP, 'cfg-no-mode.json');
  const { mode, ...withoutMode } = SHIPPED;
  writeFileSync(path, JSON.stringify(withoutMode));
  const r = run(comments([REVIEWER, marker(SHA)]), ['--config', path]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /BAD_CONFIG/);
  assert.match(r.out, /"advisory" or "enforcing"/);
});

test('the SHIPPED config is the one the gate validates', () => {
  // NO --config here, deliberately, and that is the whole test: every other test
  // passes a temp COPY, so a shipped config its own validator rejects would be
  // invisible to all of them.
  const path = join(TMP, 'p-shipped.json');
  writeFileSync(path, JSON.stringify({ headRepo: SAME_REPO, ...comments([REVIEWER, marker(SHA)]) }));
  const r = spawnSync(process.execPath, [GATE, '--pr', '1', '--sha', SHA, '--repo', SAME_REPO, '--state-file', path], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(out, /BAD_CONFIG/, 'the shipped config must pass its own validator');
  assert.ok(Array.isArray(SHIPPED.expectedAuthors) && SHIPPED.expectedAuthors.length > 0);
  assert.ok(SHIPPED.mode === 'advisory' || SHIPPED.mode === 'enforcing');
});

// ================================================================ advisory mode

test('ADVISORY: a failing verdict prints in full and exits 0', () => {
  const r = run({ issueComments: [] }, cfgWith({ mode: 'advisory' }, 'advisory-fail'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /NOT_POSTED/, 'the verdict text must be identical in both modes');
  assert.match(r.out, /ADVISORY MODE/);
});

test('ADVISORY does not suppress a REFUSAL', () => {
  // A refusal is a fact about this gate's inputs, not a verdict on the PR, so it
  // must fail closed in both modes.
  const r = run({ issueComments: { nope: true } }, cfgWith({ mode: 'advisory' }, 'advisory-refusal'));
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /ADVISORY MODE/);
});

test('the Mode line prints on a PASS too, so docs can point at it', () => {
  const r = run(comments([REVIEWER, marker(SHA)]), cfgWith({ mode: 'advisory' }, 'advisory-pass'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Mode: advisory/m);
});

test('ADVISORY does not print an advisory notice over a PASS', () => {
  // Caught by mutation: dropping the `!ok` from the advisory branch left refusals
  // and passes both exiting 0, so every existing test still passed -- while a
  // CLEAN review printed "the finding above does not fail this job" with no
  // finding above it. A notice that describes a finding that does not exist is
  // the same class of lie as a green tick over an unreviewed diff.
  const r = run(comments([REVIEWER, marker(SHA)]), cfgWith({ mode: 'advisory' }, 'advisory-clean'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /REVIEW_POSTED/);
  assert.doesNotMatch(r.out, /ADVISORY MODE/);
});

// ============================================== the machine-readable verdict

test('the `covered` output tracks the VERDICT, not the exit code', () => {
  // The CodeRabbit stand-down label reads this. In advisory mode a failing
  // verdict still exits 0, so a caller inferring coverage from `$?` would mark an
  // unreviewed PR as covered and both reviewers would stand down -- a third route
  // to an unreviewed merge. These two cases are the ones that must not agree.
  const outPath = join(TMP, `ghout-${(seq += 1)}.txt`);
  const payloadPath = join(TMP, `p-covered-${seq}.json`);
  const readOut = () => readFileSync(outPath, 'utf8');

  const runWithOutput = (payload, cfgArgs) => {
    writeFileSync(outPath, '');
    writeFileSync(payloadPath, JSON.stringify({ headRepo: SAME_REPO, ...payload }));
    const r = spawnSync(
      process.execPath,
      [GATE, '--pr', '1', '--sha', SHA, '--repo', SAME_REPO, '--state-file', payloadPath, ...cfgArgs],
      { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outPath } },
    );
    return { code: r.status, out: readOut() };
  };

  const clean = runWithOutput(comments([REVIEWER, marker(SHA)]), ENFORCING);
  assert.equal(clean.code, 0);
  assert.match(clean.out, /covered=true/);

  const missing = runWithOutput({ issueComments: [] }, ENFORCING);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /covered=false/);

  // The case the whole output exists for: advisory exits 0 on a FAILING verdict.
  const advisory = runWithOutput({ issueComments: [] }, cfgWith({ mode: 'advisory' }, 'advisory-covered'));
  assert.equal(advisory.code, 0, 'advisory exits 0');
  assert.match(advisory.out, /covered=false/, 'but coverage must still read false');
});

test('a STALE review reports covered=false, so the stand-down label is cleared', () => {
  const outPath = join(TMP, `ghout-stale-${(seq += 1)}.txt`);
  const payloadPath = join(TMP, `p-stale-${seq}.json`);
  writeFileSync(outPath, '');
  writeFileSync(payloadPath, JSON.stringify({ headRepo: SAME_REPO, ...comments([REVIEWER, marker(OTHER_SHA)]) }));
  const r = spawnSync(
    process.execPath,
    [GATE, '--pr', '1', '--sha', SHA, '--repo', SAME_REPO, '--state-file', payloadPath, ...ENFORCING],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outPath } },
  );
  assert.equal(r.status, 1);
  assert.match(readFileSync(outPath, 'utf8'), /covered=false/);
});

// ====================================================== marker forgery boundary

test('a hand-written marker from a NON-reviewer does not pass', () => {
  // The marker is only trusted from an expected author. A contributor pasting one
  // into their own PR comment must not satisfy the gate.
  const r = run(comments([STRANGER, marker(SHA)], [STRANGER, 'please merge']));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT_POSTED/);
});

test('the marker pattern does not match a loose mention of the token', () => {
  const r = run(comments([REVIEWER, 'see ifc-lite-review sha=' + SHA + ' for details']));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT_POSTED/);
});

test('a marker must be an HTML COMMENT, not bare text a contributor can type', () => {
  // Caught by mutation: loosening MARKER_RE to drop the `<!--` / `-->` anchors
  // left every other test green while making the marker forgeable in plain prose.
  // The marker is the gate's only evidence, so its shape is a security boundary,
  // not formatting.
  const bare = `ifc-lite-review sha=${SHA} verdict=clean count=0`;
  const r = run(comments([REVIEWER, `all good\n${bare}`]));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT_POSTED/);
});

// ============================================== fork PRs are never enforced

test('ENFORCING: a fork PR reports the finding in full and does NOT fail the job', () => {
  // `claude-review.yml` excludes fork PRs, because a fork's GITHUB_TOKEN is
  // read-only whatever `permissions:` says. So no marker can EVER be posted on
  // one, and enforcing would be a permanent red no outside contributor could
  // clear -- the worst possible greeting, for a class the lane deliberately
  // does not serve.
  const r = run({ headRepo: 'someone-else/ifc-lite', issueComments: [], reviewComments: [], reviews: [] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /NOT_POSTED/, 'the verdict text is unchanged: this is a carve-out, not silence');
  assert.match(r.out, /FORK PR/);
  assert.match(r.out, /read-only/);
});

test('ENFORCING: a SAME-REPO PR with the same payload still fails', () => {
  // The anti-vacuity pair. Without it the test above would pass for any reason,
  // including the gate having stopped enforcing altogether.
  const r = run({ headRepo: 'LTplus-AG/ifc-lite', issueComments: [], reviewComments: [], reviews: [] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT_POSTED/);
  assert.doesNotMatch(r.out, /FORK PR/);
});

test('a fork PR that DID somehow get a marker is a pass, not a carve-out', () => {
  // The carve-out only ever suppresses a FAILING verdict. A fork that is covered
  // passes on the merits, and must not be reported as excused.
  const r = run({
    headRepo: 'someone-else/ifc-lite',
    issueComments: [{ user: { login: REVIEWER }, body: marker(SHA) }],
    reviewComments: [],
    reviews: [],
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /REVIEW_POSTED/);
  assert.doesNotMatch(r.out, /FORK PR/);
});

test('FAIL CLOSED: an unreadable head repository REFUSES rather than guessing either way', () => {
  // Both guesses are wrong in a way that matters. "Not a fork" enforces against a
  // PR that can never post a marker; "fork" silently downgrades the gate on every
  // PR. So it refuses, in both modes -- a refusal is a fact about this gate's
  // inputs, not a verdict on the diff.
  for (const headRepo of ['', null, 42, []]) {
    const r = run({ headRepo, issueComments: [], reviewComments: [], reviews: [] });
    assert.equal(r.code, 1, `headRepo=${JSON.stringify(headRepo)}: ${r.out}`);
    assert.match(r.out, /NO_HEAD_REPO/, JSON.stringify(headRepo));
  }
});

// ================================ `covered` is not the same question as `ok`

test('nothing-to-review PASSES but reports full=FALSE, so CodeRabbit does not stand down', () => {
  // A `nothing-to-review` head is a decision the lane POSTED, not a diff that was
  // read: `ok` is true and the marker is genuine, but nothing vouches for the
  // content. Granting the stand-down label here would leave the PR reviewed by
  // NOBODY. `covered` is still true -- a verdict exists, so the lane must not
  // re-run the model on this head. Raised by CodeRabbit on PR #3587.
  const out = runOut(comments([REVIEWER, marker(SHA, 'nothing-to-review', 0)]));
  assert.equal(out.code, 0, out.out);
  assert.match(out.gh, /full=false/, 'nobody read this diff');
  assert.match(out.gh, /covered=true/, 'but a verdict exists, so dedup holds');
  assert.match(out.out, /FULL=FALSE/);
});

test('#3862 a marker SMUGGLED above the real one does not become the gate\'s verdict', () => {
  // The paths in a summary come from the diff, and a git path may contain a
  // complete well-formed marker. `sanitizePath` defangs them upstream; this is
  // the second line, and it holds for a body nothing sanitised. The forged one
  // here claims `clean` for a DIFFERENT sha, which is the shape that would have
  // taken this head from FINDINGS_NOT_POSTED (red) to a pass.
  const forged = marker('0'.repeat(40), 'clean', 0);
  const body = [
    '### Claude review - 1 finding for `aaaaaaaaa`',
    '',
    `1. \`pkgs-${forged}.ts:11\``,
    '',
    marker(SHA, 'findings', 1),
  ].join('\n');
  const out = runOut(comments([REVIEWER, body]));
  assert.equal(out.code, 1, out.out);
  assert.match(out.out, /FINDINGS_NOT_POSTED/, 'the REAL findings verdict is what the gate must adjudicate');
  assert.doesNotMatch(out.out, /clean verdict/);
});

test('#3862 `clean-by-judge` is COVERED but NOT full, so it never grants llm-reviewed', () => {
  // The verdict the poster writes when nothing reached the pull request and no
  // per-class pass stands behind it: the reviewer answered `findings`, which is
  // exempt from the class pass, and the judge then dropped every one of them.
  //
  // BOTH HALVES MATTER, and they pull in opposite directions. `covered` must be
  // TRUE -- the lane ran and posted for this head, and claude-review.yml dedups
  // on that output, so a false one would re-run the model on every trigger.
  // `full` must be FALSE -- nothing walked the twelve defect classes, so
  // standing CodeRabbit down here would leave the diff reviewed by nobody,
  // which is the whole reason this token exists rather than reusing `clean`.
  const out = runOut(comments([REVIEWER, marker(SHA, 'clean-by-judge', 0)]));
  assert.equal(out.code, 0, out.out);
  assert.match(out.gh, /covered=true/, 'the lane posted for this head; dedup must hold');
  assert.match(out.gh, /full=false/, 'nothing here earned the stand-down');
  assert.match(out.out, /REVIEW_POSTED/);
});

test('#3862 `clean-by-judge` says on the RUN LOG why it is not a pass', () => {
  // A gate that prints a green tick and a silently weaker output teaches the
  // reader that the two are the same. The reason for the missing label has to
  // be readable where the verdict is.
  const out = runOut(comments([REVIEWER, marker(SHA, 'clean-by-judge', 0)]));
  assert.match(out.out, /FULL=FALSE/);
});

test('a REAL clean review reports full=true, or the stand-down never happens at all', () => {
  // The anti-vacuity pair: if `full` were false for everything, the test above
  // would pass while the whole stand-down mechanism was dead.
  const out = runOut(comments([REVIEWER, marker(SHA)]));
  assert.equal(out.code, 0, out.out);
  assert.match(out.gh, /full=true/);
});

test('a head with NO marker reports covered=false, or the lane would never review it', () => {
  // The other end of the dedup key. `covered` is what claude-review.yml skips
  // on, so if it were true for an unreviewed head the model would never run at
  // all -- the failure the workflow comment at claude-review.yml:101-104 names.
  const out = runOut(comments([REVIEWER, 'Just a comment, no marker.']));
  assert.equal(out.code, 1, out.out);
  assert.match(out.gh, /covered=false/);
  assert.match(out.gh, /full=false/);
});

test('the fork comparison is CASE-INSENSITIVE, or enforcement is off for everyone', () => {
  // GitHub repo names are case-insensitive and `--repo` is caller-supplied, so
  // `ltplus-ag/...` against a head repo of `LTplus-AG/...` would read as a fork
  // and excuse every failing verdict.
  const r = run({ headRepo: 'LTplus-AG/ifc-lite', issueComments: [], reviewComments: [], reviews: [] }, [
    ...ENFORCING, '--repo', 'ltplus-ag/IFC-Lite',
  ]);
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /FORK PR/, 'the same repo in another case is not a fork');
});

test('FAIL CLOSED: the fork check REFUSES when no repository was resolved', () => {
  // `args.repo` is only refused inside the live branch, so a state-file run can
  // reach here with null -- and `headRepo !== null` is true for every value,
  // which would excuse every failing verdict. A gate that cannot fail.
  const path = join(TMP, `p-norepo-${(seq += 1)}.json`);
  writeFileSync(path, JSON.stringify({ headRepo: SAME_REPO, issueComments: [], reviewComments: [], reviews: [] }));
  const r = spawnSync(
    process.execPath,
    [GATE, '--pr', '1', '--sha', SHA, '--state-file', path, ...ENFORCING],
    { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '' } },
  );
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /NO_REPO/);
});

// ============================ the gate must outwait the lane it is waiting FOR

test('THE RACE: the shared producer/consumer budget rejects either side shrinking', () => {
  // MEASURED, on PR #3593, with the gate already enforcing:
  //
  //   gate gave up after 600 s   05:12:43
  //   lane posted the marker     05:13:12   <- 29 seconds later
  //
  // NOT_POSTED on a PR whose review was fine. And it is structural, not a tuning
  // miss: `claude-review.yml` may legitimately run until ITS OWN
  // `timeout-minutes`, so any gate budget below that number can expire while the
  // producer is still working. 600 s against a 1200 s producer was a coin flip
  // the gate was always going to lose eventually; observed lane runs that
  // actually reviewed took 525 s and 676 s, either side of it.
  //
  // The shared executable contract is used by both lanes. THE COPIES below
  // pins it to the two workflow literals it cannot read at run time.
  assert.doesNotThrow(assertReviewLaneBudget);
  // THE CONCRETE NUMBER, not `String(REVIEW_POSTED_POLL_SECONDS)`: deriving the
  // expectation from the thing under test asserts only that the function
  // returns its own input, and stays green through any constant change. 1500 s
  // is the budget the two workflow caps below (20 min lane, 30 min job) were
  // chosen against, so changing it must be acknowledged here.
  const REMEDY = 'the poll budget is a contract with the two workflow caps below: restore 1500, or change the constant, this pin and both caps together';
  assert.equal(pollSecondsArgument(), '1500', REMEDY);
  assert.equal(REVIEW_POSTED_POLL_SECONDS, 1500, REMEDY);

  assert.throws(
    () => assertReviewLaneBudget({ pollSeconds: REVIEW_LANE_TIMEOUT_SECONDS }),
    /raise the poll budget above/,
    'equal budgets reproduce the race',
  );
  assert.throws(
    () => assertReviewLaneBudget({ laneTimeoutSeconds: REVIEW_POSTED_POLL_SECONDS + 1 }),
    /raise the poll budget above/,
    'raising the producer cap alone reproduces the race',
  );
  assert.throws(
    () =>
      assertReviewLaneBudget({
        gateJobTimeoutSeconds: REVIEW_POSTED_POLL_SECONDS + REVIEW_POSTED_MINIMUM_GRACE_SECONDS - 1,
      }),
    /raise .*timeout-minutes.* or lower the poll budget/,
    'the gate cannot be killed before it prints its verdict',
  );
});

// The constants above are the AUTHORITY, but `timeout-minutes:` is evaluated by
// GitHub before any step runs, so no workflow can read them at run time. That
// leaves a copy in each YAML, and a copy held together only by prose drifts:
// the very race this module exists to prevent comes back the moment someone
// edits one number. Bind the copies to the authority here -- this is a gate on
// the duplication the design cannot remove, not a restatement of the module.
const GATE_STEP = 'Check a review was actually posted for this head';

const BUDGET_CLI = join(HERE, 'review-lane-budget.mjs');
const budgetCli = (...args) => {
  const r = spawnSync(process.execPath, [BUDGET_CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

/**
 * THE COMMAND LINE, not the exported function. Every other test here imports
 * `pollSecondsArgument()`, and all of them stayed green while the module had no
 * CLI at all: `node scripts/review-lane-budget.mjs --poll-seconds` printed
 * NOTHING and exited 0, so the workflow's command substitution would have set an
 * empty `poll_seconds` and the gate would have exited BAD_ARGS on every PR. The
 * wiring pin cannot see that -- it reads the workflow's text, and the text was
 * right. Only spawning the thing catches it. Raised by /simplify on PR #3610.
 */
test('THE CLI: the spelling the workflow runs prints the poll budget', () => {
  const ok = budgetCli('--poll-seconds');
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, '1500', 'the workflow captures stdout; an empty capture is BAD_ARGS on every PR');
});

test('THE CLI: an argument it does not implement FAILS rather than printing nothing', () => {
  // The silent-exit-0 shape is the whole defect: with `set -e` a non-zero exit
  // stops the step loudly, while an empty stdout travels on and misconfigures
  // the gate. Both an unknown flag and no flag at all must take the loud path.
  for (const args of [['--bogus'], [], ['--poll-seconds', 'extra']]) {
    const r = budgetCli(...args);
    assert.notEqual(r.code, 0, `\`${args.join(' ')}\` must not exit 0: ${r.out}`);
    assert.equal(r.out, '', 'nothing may reach stdout on the failure path');
    assert.match(r.err, /usage: node scripts\/review-lane-budget\.mjs --poll-seconds/);
  }
});

/**
 * The wiring the gate step's shell must actually execute, pinned to the EXACT
 * spelling that ships. A loose `[\s\S]*?` between the halves let any invocation
 * of the module count -- including the `node --input-type=module --eval` form
 * this replaced, and including a `--poll-seconds` flag the module does not
 * implement. There is one command line CI runs; this is it.
 *
 * Both halves are literal shell, so this is ORDERED SUBSTRING CONTAINMENT, not
 * a pattern: `$`, `(` and `"` are all regex metacharacters, and escaping them
 * by hand to ask a question `indexOf` already answers is how the loose bridge
 * got there in the first place.
 */
const WIRED_ASSIGNMENT = 'poll_seconds="$(node scripts/review-lane-budget.mjs --poll-seconds)"';
const WIRED_PASS = '--timeout-seconds "$poll_seconds"';

/** Does this shell set `poll_seconds` from the module and then pass it on, in that order? */
function isWiredPoll(script) {
  const assigned = script.indexOf(WIRED_ASSIGNMENT);
  return assigned !== -1 && script.indexOf(WIRED_PASS, assigned + WIRED_ASSIGNMENT.length) !== -1;
}

/**
 * The EXECUTED shell of one workflow step: its `run:` block scalar with comment
 * lines removed. `null` when the step is absent, `''` when it has no `run:`.
 *
 * Matching the raw YAML of the step instead let COMMENT TEXT satisfy the pin --
 * a step hard-coding `--timeout-seconds 600` passes as long as some comment
 * above it happens to name the module and the variable. Raised by CodeRabbit on
 * PR #3610; the fixture below is that exact shape.
 */
function stepRunScript(text, stepName) {
  const start = text.indexOf(`- name: ${stepName}`);
  if (start === -1) return null;
  const after = text.slice(start + 1);
  const nextStep = after.search(/\n {6}- /);
  const step = nextStep === -1 ? after : after.slice(0, nextStep);
  const lines = step.split('\n');
  const runAt = lines.findIndex((line) => /^ {8}run: \|/.test(line));
  if (runAt === -1) return '';
  return lines
    .slice(runAt + 1)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

// Anti-vacuity for the pin below: prove the matcher reads the SHELL, not the
// prose around it. Without this the strengthening is untested, and the weaker
// raw-YAML form it replaces would pass every assertion in THE COPIES.
test('THE COPIES: a COMMENT naming the module cannot satisfy the wiring pin', () => {
  const unwired = [
    'jobs:',
    '  gate:',
    '    timeout-minutes: 30',
    '    steps:',
    `      - name: ${GATE_STEP}`,
    '        run: |',
    `          # ${WIRED_ASSIGNMENT}`,
    `          # node scripts/check-review-posted.mjs ${WIRED_PASS}`,
    '          node scripts/check-review-posted.mjs --timeout-seconds 600',
    '      - name: something after',
    '        run: echo done',
    '',
  ].join('\n');

  assert.equal(
    isWiredPoll(stepRunScript(unwired, GATE_STEP)),
    false,
    'a hard-coded --timeout-seconds must stay red however faithfully a COMMENT describes ' +
      'the wiring: a comment is not what CI runs',
  );
  // The same file with those two lines uncommented IS wired, so the assertion
  // above fails on the comments and not on some unrelated difference.
  assert.ok(isWiredPoll(stepRunScript(unwired.replaceAll('          # ', '          '), GATE_STEP)));
  assert.equal(stepRunScript(unwired, 'a step that is not there'), null);
});

test('THE COPIES: both workflows carry the job caps the budget module assumes', () => {
  const workflow = (name) => readFileSync(join(HERE, '..', '.github/workflows', name), 'utf8');
  const jobTimeoutSeconds = (name, text) => {
    // Job keys sit at 4-space indent, step keys at 8: anchoring to the job
    // level lets a step carry its own timeout-minutes without a false red.
    const found = [...text.matchAll(/^ {4}timeout-minutes:[ \t]*(\d+)/gm)];
    assert.equal(
      found.length,
      1,
      `${name} must declare exactly one JOB timeout, found ${found.length}. ` +
        'REMEDY: keep exactly one 4-space-indented `timeout-minutes:` in that workflow. ' +
        'A step-level cap belongs at 8-space indent and is not what the budget module reads; ' +
        'two job-level caps make "the job timeout" ambiguous and this module would pick one ' +
        'arbitrarily.',
    );
    return Number(found[0][1]) * 60;
  };
  const gateText = workflow('review-posted.yml');

  assert.equal(
    jobTimeoutSeconds('claude-review.yml', workflow('claude-review.yml')),
    REVIEW_LANE_TIMEOUT_SECONDS,
    'claude-review.yml timeout-minutes drifted from REVIEW_LANE_TIMEOUT_SECONDS: the gate ' +
      'sizes its poll against that constant, so change both or the gate can give up while ' +
      'the reviewer is still legitimately working',
  );
  assert.equal(
    jobTimeoutSeconds('review-posted.yml', gateText),
    REVIEW_POSTED_JOB_TIMEOUT_SECONDS,
    'review-posted.yml timeout-minutes drifted from REVIEW_POSTED_JOB_TIMEOUT_SECONDS: the ' +
      'job would be killed mid-poll and report no verdict at all, so change both',
  );

  // The gate reads its poll budget from the module rather than from a literal.
  // Pin PRODUCER TO CONSUMER, and pin them WITHIN ONE STEP, and pin them in the
  // EXECUTED shell. All three weaker forms were shown green against a broken
  // workflow: asserting the two halves separately passed with the module fully
  // unwired (`poll_seconds=1500` plus a comment naming both symbols); a
  // whole-file match passed with the substitution moved into its own preceding
  // step -- where a shell variable does not survive, so `$poll_seconds` expands
  // to empty and the gate exits BAD_ARGS on every PR; and matching the raw YAML
  // of the step passed on COMMENT TEXT alone, next to a hard-coded
  // `--timeout-seconds 600`. The third is why `stepRunScript` strips comments.
  const runScript = stepRunScript(gateText, GATE_STEP);
  assert.notEqual(
    runScript,
    null,
    `review-posted.yml must carry the step '${GATE_STEP}'. REMEDY: restore that step by name. ` +
      'The budget contract is asserted against THAT step, so renaming it silently detaches ' +
      'the contract from the thing it governs rather than failing loudly.',
  );
  assert.ok(
    isWiredPoll(runScript),
    `the '${GATE_STEP}' step must pass --timeout-seconds the value it read, in that same step, ` +
      `from review-lane-budget.mjs. REMEDY: inside that one step, set \`${WIRED_ASSIGNMENT}\` ` +
      `and pass \`${WIRED_PASS}\`. THE REMEDY IS BUILT FROM THE MATCHER, so it cannot ` +
      'describe a spelling the pin would reject. IN THAT SAME STEP is the whole point: a shell ' +
      'variable does not survive across steps, so splitting them expands to empty and the ' +
      'gate exits BAD_ARGS on every PR while still looking wired.',
  );
});

// =============================== drafts are never enforced either

test('ENFORCING: a DRAFT PR reports the finding in full and does NOT fail the job', () => {
  // `claude-review.yml` gates on `draft == false`; this workflow has no `if:` and
  // runs on drafts anyway. Under enforcing that made every same-repo draft a
  // permanent red: the lane skips identically on every re-run, so the printed
  // "re-run the review job" could never clear it. Third instance of the
  // unclearable-red class, after nothing-reviewable and forks.
  const r = run({ headRepo: SAME_REPO, draft: true, issueComments: [], reviewComments: [], reviews: [] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /NOT_POSTED/, 'the verdict text is unchanged: an exemption, not silence');
  assert.match(r.out, /DRAFT PR/);
  assert.match(r.out, /Mark it ready for review/);
});

test('ENFORCING: the SAME payload without the draft flag still fails', () => {
  // Anti-vacuity. Without this the test above would pass even if the gate had
  // stopped enforcing entirely.
  const r = run({ headRepo: SAME_REPO, draft: false, issueComments: [], reviewComments: [], reviews: [] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT_POSTED/);
  assert.doesNotMatch(r.out, /DRAFT PR|FORK PR/);
});

test('a draft that IS covered passes on the merits, not as an exemption', () => {
  // The exemption only ever suppresses a FAILING verdict; a covered draft must
  // not be reported as excused.
  const r = run({
    headRepo: SAME_REPO,
    draft: true,
    issueComments: [{ user: { login: REVIEWER }, body: marker(SHA) }],
    reviewComments: [],
    reviews: [],
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /REVIEW_POSTED/);
  assert.doesNotMatch(r.out, /DRAFT PR/);
});

test('DRAFT wins over FORK in the message, because it is the one the author can change', () => {
  const r = run({ headRepo: 'someone/ifc-lite', draft: true, issueComments: [], reviewComments: [], reviews: [] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /DRAFT PR/);
});

test('an EXEMPT run prints ONE remedy, not two that contradict each other', () => {
  // The failing verdicts end in `REMEDY: re-run the review job`, which is right
  // for a quota blip and wrong for a draft or a fork: no re-run can produce a
  // marker the lane will not write. Printing both left the reader with two
  // instructions that disagree, which this repository treats as a defect in its
  // own right. Raised by CodeRabbit on PR #3598.
  // ASSERT ON THE INSTRUCTION, NOT ON THE PREFIX. The first version of this test
  // checked only that no line STARTS with `REMEDY:`, and passed while a remedy
  // split across two array entries lost its head and printed the tail --
  // "...rather than re-running indefinitely" dangling beside an exemption saying
  // no re-run can help. 51 of 51 green with the defect live. Caught in review.
  //
  // The assertion is on the ORPHAN'S OWN TEXT, not on the word "re-run": the
  // exemption legitimately says "no re-run could clear this", so a blanket match
  // would fire on the correct output. These two fragments only ever appear in
  // the tail of a split remedy.
  const noReRunAdvice = (out, why) => {
    assert.doesNotMatch(out, /REMEDY:/, `${why}: the re-run remedy cannot work here`);
    assert.doesNotMatch(out, /rather than re-running indefinitely/, `${why}: orphaned remedy tail`);
    assert.doesNotMatch(out, /attach it to/, `${why}: orphaned remedy tail`);
  };

  const draft = run({ headRepo: SAME_REPO, draft: true, issueComments: [], reviewComments: [], reviews: [] });
  noReRunAdvice(draft.out, 'draft, nothing posted');
  assert.match(draft.out, /Mark it ready for review/, 'and the one that CAN work is still there');

  const fork = run({ headRepo: 'someone/ifc-lite', issueComments: [], reviewComments: [], reviews: [] });
  noReRunAdvice(fork.out, 'fork, nothing posted');

  // The OTHER multi-line remedy: FINDINGS_NOT_POSTED. Same orphan, different verdict.
  const findings = run({
    headRepo: SAME_REPO,
    draft: true,
    issueComments: [{ user: { login: REVIEWER }, body: marker(SHA, 'findings', 3) }],
    reviewComments: [],
    reviews: [],
  });
  assert.equal(findings.code, 0, findings.out);
  noReRunAdvice(findings.out, 'draft, findings claimed but not posted');

  // ANTI-VACUITY: a real failure must KEEP its remedy, or this test would pass
  // by the gate having stopped printing remedies at all.
  const real = run({ headRepo: SAME_REPO, draft: false, issueComments: [], reviewComments: [], reviews: [] });
  assert.equal(real.code, 1);
  assert.match(real.out, /REMEDY: re-run the review job/);
});

test('THE TWO OUTPUTS GO TO THE TWO CONSUMERS: `covered` dedups, `full` stands CodeRabbit down', () => {
  // The wiring this gate's whole contract rests on, and it was held together by
  // prose. A first attempt at the partial-review fix made `covered` false for a
  // degraded head, which fixed the stand-down and silently broke the dedup:
  // claude-review.yml gates EVERY step of its job on `steps.dedup.outputs.covered`,
  // so a partial head would have been re-reviewed on each re-trigger and posted
  // its inline comments again. Nothing failed. This is that test.
  const labels = readFileSync(join(HERE, '..', '.github/workflows/review-posted.yml'), 'utf8');
  const lane = readFileSync(join(HERE, '..', '.github/workflows/claude-review.yml'), 'utf8');

  // The label workflow reads `full` and NOTHING reads `covered` there: the
  // stand-down is a claim about the WHOLE diff.
  assert.match(labels, /steps\.gate\.outputs\.full == 'true'/, 'the label is not gated on `full`');
  assert.match(labels, /steps\.gate\.outputs\.full == 'false'/, 'the clear step is not gated on `full`');
  assert.equal(
    [...labels.matchAll(/steps\.gate\.outputs\.covered/g)].length,
    0,
    'review-posted.yml reads `covered`, which is the dedup key, not the coverage claim',
  );

  // The review lane dedups on `covered` and never on `full`: a partial head has
  // been reviewed once and must not be reviewed again.
  assert.ok(
    [...lane.matchAll(/steps\.dedup\.outputs\.covered/g)].length > 0,
    'claude-review.yml does not dedup on `covered`',
  );
  assert.equal(
    [...lane.matchAll(/steps\.dedup\.outputs\.full/g)].length,
    0,
    'claude-review.yml dedups on `full`, so every degraded head would be re-reviewed',
  );
});

test('THE LABEL NAME IS ONE NAME: the workflow that writes it and the config that reads it agree', () => {
  // Nothing asserted this. `review-posted.yml` creates, applies, reads back and
  // clears the label; `.coderabbit.yaml` is the only consumer, and no code reads
  // that file — so producer and consumer were held together by prose alone. A
  // rename touching one and not the other shipped green, which is exactly the
  // shape a vendor-agnostic rename walks into.
  //
  // Mutation-checked when written: renaming the label in the workflow alone
  // failed no test at all.
  const wf = readFileSync(join(HERE, '..', '.github/workflows/review-posted.yml'), 'utf8');
  const cr = readFileSync(join(HERE, '..', '.coderabbit.yaml'), 'utf8');

  // Every label the workflow creates or applies, taken from the commands
  // themselves rather than from a constant this test could get wrong too.
  const created = [...wf.matchAll(/gh label create ([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  const applied = [...wf.matchAll(/labels\[\]=([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  const names = new Set([...created, ...applied]);
  assert.equal(names.size, 1, `the workflow handles more than one label name: ${[...names].join(', ')}`);
  const label = [...names][0];

  // The read-back grep and both clear paths must name the same one.
  assert.match(wf, new RegExp(`grep -qx '${label}'`), `the read-back does not check \`${label}\``);
  // EVERY `/labels/<name>` path, not just one of them. `includes` passed while a
  // clear step pointed at a different name, because the other occurrence still
  // matched -- the same "asserts less than its name claims" shape this session
  // has already found twice.
  const labelPaths = [...wf.matchAll(/\/labels\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  // BOTH clear paths, counted. `> 0` asserted less than its own message: deleting
  // one of the two DELETE steps outright left this green, mutation-proven. That is
  // the second time this exact test has asserted less than it claims -- the first
  // was `includes` passing while a path pointed elsewhere. The workflow clears the
  // label on a new head AND when the gate reports not-covered; losing either
  // leaves the label stuck on a commit nothing vouches for.
  assert.equal(
    labelPaths.length,
    2,
    `the workflow has ${labelPaths.length} \`/labels/<name>\` paths; it needs both clear steps ` +
      '(new-head and not-covered), so a count other than two means one was lost or added silently',
  );
  for (const p of labelPaths) {
    assert.equal(p, label, `a label path targets \`${p}\` while the workflow applies \`${label}\``);
  }

  // And the consumer, whose rule is currently commented out under the
  // stand-down — the name still has to match, or re-enabling it silently
  // stops matching anything.
  assert.ok(
    cr.includes(`'!${label}'`),
    `.coderabbit.yaml does not reference \`!${label}\`; the stand-down rule would match nothing when re-enabled`,
  );
  assert.ok(!/claude-reviewed/.test(wf + cr), 'a vendor-named label survives in the workflow or the CodeRabbit config');
});


// ============ `dropped`: a decision that must NOT seal the head (#3775)

test('a `dropped` marker reports covered=FALSE, so the next run reviews the head again', () => {
  // #3775 needs an all-findings-dropped run to leave a RECORD rather than an
  // unclearable red. Reusing `nothing-to-review` for it would be wrong in a way
  // that is quiet rather than loud: that verdict is `ok`, `main()` writes
  // `covered=${ok}`, and claude-review.yml gates its whole job on that output --
  // so the first all-dropped run would SEAL the head, and a harness regression
  // dropping every finding on every PR would go silent instead of red.
  const out = runOut(comments([REVIEWER, marker(SHA, 'dropped', 0)]));
  assert.match(out.gh, /covered=false/, 'the lane must be free to review this head again');
  assert.match(out.gh, /full=false/, 'and CodeRabbit must not stand down on it');
  assert.match(out.out, /FINDINGS_ALL_DROPPED/);
  assert.match(out.out, /re-run/i, 'a remedy a re-run can actually carry out');
});

test('a `dropped` marker is well-formed, not MARKER_MALFORMED', () => {
  // The gate must PARSE it. If MARKER_RE did not accept the verdict, the marker
  // would read as garbage from an expected author and the diagnosis would send
  // the reader to fix the poster rather than the review.
  const out = runOut(comments([REVIEWER, marker(SHA, 'dropped', 0)]));
  assert.doesNotMatch(out.out, /MARKER_MALFORMED/);
});

test('shouldKeepPolling: a `dropped` verdict ends the wait, an absent one does not', () => {
  // `dropped` is not `ok`, and the loop waits on `!ok` alone -- so this gate
  // would sit out its whole 25-minute budget, about 200 API calls against a
  // 1,000/hour token shared with three other jobs, before printing a verdict it
  // already had on the first read. The lane job that wrote that marker has
  // EXITED; nothing is coming.
  assert.equal(shouldKeepPolling({ ok: false, verdict: 'FINDINGS_ALL_DROPPED', terminal: true }), false);

  // The anti-vacuity half: the verdicts the poll exists FOR must still wait.
  assert.equal(shouldKeepPolling({ ok: false, verdict: 'NOT_POSTED' }), true);
  assert.equal(shouldKeepPolling({ ok: false, verdict: 'STALE_REVIEW' }), true);
  assert.equal(shouldKeepPolling({ ok: false, verdict: 'FINDINGS_NOT_POSTED' }), true);
  assert.equal(shouldKeepPolling({ ok: true, verdict: 'REVIEW_POSTED' }), false);
});

test('evaluate marks a `dropped` result terminal, and nothing else', () => {
  // The flag and the loop are two halves of one behaviour; testing the predicate
  // alone would pass with `terminal` never set by anybody.
  const cfg = { expectedAuthors: new Set([REVIEWER]), mode: 'enforcing' };
  const dropped = evaluate({
    comments: [{ author: REVIEWER, body: marker(SHA, 'dropped', 0), surface: 'issueComments', raw: {} }],
    cfg,
    headSha: SHA,
  });
  assert.equal(dropped.verdict, 'FINDINGS_ALL_DROPPED');
  assert.equal(dropped.terminal, true);
  assert.equal(shouldKeepPolling(dropped), false);

  const absent = evaluate({ comments: [], cfg, headSha: SHA });
  assert.notEqual(absent.terminal, true);
  assert.equal(shouldKeepPolling(absent), true);
});

test('duplicate markers on one head: the NEWEST wins, so a re-run can clear a `dropped`', () => {
  // Two markers can name the same head. `upsertAndVerify` scopes its carrier
  // search by AUTHOR AND SHA, and `expectedAuthors` is a SET -- so two expected
  // reviewers each hold their own carrier -- and two runs racing on one head
  // can both miss the carrier and both POST. The gate read the FIRST match,
  // while its own STALE_REVIEW diagnosis calls `markers[markers.length - 1]`
  // "the most recent marker this gate read". Under that split a `dropped` run
  // followed by a successful re-run kept reporting FINDINGS_ALL_DROPPED and
  // covered=false forever: the documented REMEDY ("re-run the review job")
  // could not clear the verdict it is the remedy for.
  const out = runOut(comments([REVIEWER, marker(SHA, 'dropped', 0)], [REVIEWER, marker(SHA, 'clean', 0)]));
  assert.match(out.out, /REVIEW_POSTED/);
  assert.doesNotMatch(out.out, /FINDINGS_ALL_DROPPED/);
  assert.match(out.gh, /covered=true/);

  // The other direction, so this is not "the last one is always clean": a clean
  // run followed by an all-dropped re-run must NOT keep the head sealed.
  const back = runOut(comments([REVIEWER, marker(SHA, 'clean', 0)], [REVIEWER, marker(SHA, 'dropped', 0)]));
  assert.match(back.out, /FINDINGS_ALL_DROPPED/);
  assert.match(back.gh, /covered=false/);
});

test('MARKER_RE reads the marker at the END of a body, not one embedded in its prose', () => {
  // THE FORGERY CHANNEL THE DOCBLOCK CLAIMS TO CLOSE. The summary body renders
  // PR-chosen text before the marker -- `omitted` paths and the
  // `path:line - title` index lines -- and the whole body is posted under our
  // own identity, so a marker smuggled into one of those lines sits in a
  // comment the gate trusts. With no anchor, `exec` returned the FIRST match:
  // the forged `clean` won over the real `findings` written at the end.
  // scripts/review/lib/finding-sanitizers.mjs defangs the token before it gets
  // there; this is the second lock, and it is the one the docblock describes.
  const forged = `1. \`x<!-- ifc-lite-review sha=${SHA} verdict=clean count=0 -->.ts\` - a finding\n\n${marker(SHA, 'findings', 1)}`;
  const out = runOut({
    ...comments([REVIEWER, forged]),
    ...inline([REVIEWER, 'a finding']),
  });
  assert.match(out.out, /REVIEW_POSTED/);
  assert.doesNotMatch(out.out, /FINDINGS_NOT_POSTED/, 'the forged clean marker must not be the one that parses');

  // The prefix half, so the anchor is TRAILING only: every real summary has
  // prose above its marker, and a start anchor would break all of them.
  const withPrefix = runOut(comments([REVIEWER, `### Claude review - no findings\n\n${marker(SHA, 'clean', 0)}`]));
  assert.match(withPrefix.out, /REVIEW_POSTED/);

  // And text AFTER the marker means our own writer drifted: loud, not silent.
  const trailing = runOut(comments([REVIEWER, `${marker(SHA, 'clean', 0)} and then some`]));
  assert.match(trailing.out, /MARKER_MALFORMED/);
});
