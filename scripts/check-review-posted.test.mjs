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
function run(payload, extra = [...ENFORCING], sha = SHA) {
  const path = join(TMP, `payload-${(seq += 1)}.json`);
  writeFileSync(path, JSON.stringify(payload));
  const r = spawnSync(process.execPath, [GATE, '--pr', '1', '--sha', sha, '--state-file', path, ...extra], {
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const comments = (...cs) => ({ issueComments: cs.map(([user, body]) => ({ user: { login: user }, body })) });

// ============================================================ the core verdicts

test('PASS: the expected reviewer posted a marker naming this head', () => {
  const r = run(comments([REVIEWER, `Looks fine.\n${marker(SHA)}`]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /REVIEW_POSTED/);
  assert.match(r.out, /clean verdict/);
});

test('PASS: a findings verdict carries its count', () => {
  const r = run(comments([REVIEWER, `Three things.\n${marker(SHA, 'findings', 3)}`]));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /findings verdict.*with 3 finding/);
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

test('FAIL-CLOSED: a comment list at the page limit refuses rather than reporting absence', () => {
  const many = Array.from({ length: 200 }, () => ({ user: { login: STRANGER }, body: 'x' }));
  const r = run({ issueComments: many });
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
  writeFileSync(path, JSON.stringify(comments([REVIEWER, marker(SHA)])));
  const r = spawnSync(process.execPath, [GATE, '--pr', '1', '--state-file', path, ...ENFORCING], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /NO_SHA/);
});

test('FAIL-CLOSED: a short or non-hex --sha is refused', () => {
  const r = run(comments([REVIEWER, marker(SHA)]), [...ENFORCING], 'abc123');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NO_SHA/);
});

// =================================================================== the config

test('an EMPTY expectedAuthors list is refused, not treated as "anyone"', () => {
  const r = run(comments([STRANGER, marker(SHA)]), cfgWith({ expectedAuthors: [] }, 'empty-authors'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /BAD_CONFIG/);
  assert.match(r.out, /every PR pass on any comment/);
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
  writeFileSync(path, JSON.stringify(comments([REVIEWER, marker(SHA)])));
  const r = spawnSync(process.execPath, [GATE, '--pr', '1', '--sha', SHA, '--state-file', path], { encoding: 'utf8' });
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
