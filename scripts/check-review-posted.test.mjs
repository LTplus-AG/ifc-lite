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
import { pageAll } from './check-review-posted.mjs';

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

/** Inline review comments, which is the surface a FINDING lives on and the one #1679 drops. */
const inline = (...cs) => ({
  reviewComments: cs.map(([user, body, commit_id = SHA]) => ({ user: { login: user }, body, commit_id })),
});

// ============================================================ the core verdicts

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
  assert.match(r.out, /force-push re-anchors/);
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

test('nothing-to-review PASSES but reports covered=FALSE, so CodeRabbit does not stand down', () => {
  // The hole this closes: `review-posted.yml` turns `covered` into the
  // `llm-reviewed` label, and `.coderabbit.yaml` skips labelled PRs. A
  // nothing-to-review head was never READ by anything, so claiming coverage
  // would stand CodeRabbit down too and leave the PR reviewed by NOBODY.
  const outPath = join(TMP, `ghout-ntr-${(seq += 1)}.txt`);
  const payloadPath = join(TMP, `p-ntr-${seq}.json`);
  writeFileSync(outPath, '');
  writeFileSync(
    payloadPath,
    JSON.stringify({ headRepo: SAME_REPO, ...comments([REVIEWER, marker(SHA, 'nothing-to-review', 0)]) }),
  );
  const r = spawnSync(
    process.execPath,
    [GATE, '--pr', '1', '--sha', SHA, '--repo', SAME_REPO, '--state-file', payloadPath, ...ENFORCING],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outPath } },
  );
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(readFileSync(outPath, 'utf8'), /covered=false/, 'nobody read this diff');
  assert.match(`${r.stdout}${r.stderr}`, /COVERED=FALSE/);
});

test('a REAL clean review reports covered=true, or the stand-down never happens at all', () => {
  // The anti-vacuity pair: if `covered` were false for everything, the test above
  // would pass while the whole stand-down mechanism was dead.
  const outPath = join(TMP, `ghout-clean-${(seq += 1)}.txt`);
  const payloadPath = join(TMP, `p-clean-${seq}.json`);
  writeFileSync(outPath, '');
  writeFileSync(payloadPath, JSON.stringify({ headRepo: SAME_REPO, ...comments([REVIEWER, marker(SHA)]) }));
  const r = spawnSync(
    process.execPath,
    [GATE, '--pr', '1', '--sha', SHA, '--repo', SAME_REPO, '--state-file', payloadPath, ...ENFORCING],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outPath } },
  );
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(readFileSync(outPath, 'utf8'), /covered=true/);
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

test('THE RACE: the gate\'s poll budget exceeds the LANE\'s own job timeout', () => {
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
  // The relationship lives in TWO FILES and nothing connected them, which is the
  // matched-pair shape this repository keeps paying for. Connected here.
  const here = dirname(fileURLToPath(import.meta.url));
  const wf = (n) => readFileSync(join(here, '..', '.github/workflows', n), 'utf8');

  const laneCap = /^[ \t]*timeout-minutes:[ \t]*(\d+)/m.exec(wf('claude-review.yml'));
  assert.ok(laneCap, 'claude-review.yml must carry a job timeout');

  const gateText = wf('review-posted.yml');
  const budget = /^[ \t]*--timeout-seconds[ \t]+(\d+)/m.exec(gateText);
  const gateCap = /^[ \t]*timeout-minutes:[ \t]*(\d+)/m.exec(gateText);
  assert.ok(budget && gateCap, 'review-posted.yml must carry both an explicit budget and a job cap');

  const laneSeconds = Number(laneCap[1]) * 60;
  const budgetSeconds = Number(budget[1]);
  assert.ok(
    budgetSeconds > laneSeconds,
    `the gate waits ${budgetSeconds}s but the lane may run ${laneSeconds}s: the gate can give up ` +
      'while the reviewer is still legitimately working, and report NOT_POSTED on a good PR',
  );
  // And the gate's own job must outlive its poll, or it is killed mid-wait and
  // reports `cancelled` with no verdict at all.
  assert.ok(
    Number(gateCap[1]) * 60 - budgetSeconds >= 300,
    `job cap ${gateCap[1]}min leaves ${Number(gateCap[1]) * 60 - budgetSeconds}s over a ${budgetSeconds}s budget`,
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
