/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The property under test is asymmetric, and stating it decides every case
 * below: A MISCLASSIFIED LOW-RISK PR LOSES A REVIEW; a misclassified high-risk
 * PR only wastes one. So every ambiguous case must fall to high-risk, and the
 * tests that matter most are the ones asserting something is NOT low-risk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, isLowRiskPath } from './classify-pr-risk.mjs';

test('prose is low risk', () => {
  assert.equal(classify(['docs/guide.md', 'README.md']).lowRisk, true);
});

test('ANYTHING THE LANE ALSO SKIPS IS HIGH RISK, or the PR is reviewed by NOBODY', () => {
  // THE BUG THIS CATCHES, found in review before it shipped. The first version
  // borrowed the lane's `isExcluded` with an OR, so `fixtures/`, `pkg/`, `dist/`,
  // `.snap` and lockfiles counted as low-risk. But the LANE skips those too --
  // `claude-review.yml` turns them into NO_FILES and never runs the model. So
  // CodeRabbit would have been labelled off on a PR nothing else reviewed, while
  // the workflow printed "the Claude lane still reviews it".
  //
  // Low-risk means "CodeRabbit may skip because the lane WILL read it". Where the
  // lane does not read, CodeRabbit is the only reader left.
  for (const p of [
    'packages/viewer/src/fixtures/loader.ts',
    'Cargo.lock',
    'pnpm-lock.yaml',
    'packages/x/pkg/a.d.ts',
    'packages/x/dist/a.js',
    'packages/x/__snapshots__/a.snap',
    'scripts/api-surface.json',
  ]) {
    assert.equal(isLowRiskPath(p), false, `${p} must stay reviewable by CodeRabbit`);
    assert.equal(classify([p]).lowRisk, false, p);
  }
});

test('ONE real file makes the whole PR high risk', () => {
  // Not a majority vote. A PR is reviewed as a unit, and the excluded files
  // riding along do not dilute the one that matters.
  const v = classify(['docs/guide.md', 'README.md', 'packages/parser/src/step.ts']);
  assert.equal(v.lowRisk, false);
  assert.match(v.why, /packages\/parser\/src\/step\.ts/, 'and it names which one');
});

test('A CHANGESET IS NEVER LOW RISK, even though it is a .md file', () => {
  // THE BUG THIS TEST CAUGHT. `.changeset/nice-cats.md` matched the `\.md$` prose
  // rule and came out low-risk -- the exact class the module's own docblock
  // singles out as dangerous, because a changeset naming a package that does not
  // exist fails the RELEASE workflow, which only runs on main. #3175: twelve
  // wrong version bumps.
  assert.equal(isLowRiskPath('.changeset/nice-cats.md'), false);
  assert.equal(classify(['.changeset/nice-cats.md']).lowRisk, false);
});

test('a workflow file is never low risk', () => {
  // CI configuration decides what every other gate does; a wrong line here is
  // invisible until something that should have failed does not.
  assert.equal(isLowRiskPath('.github/workflows/test.yml'), false);
});

test('TEST-ONLY diffs are HIGH risk here, which is the opposite of the usual call', () => {
  // This repository's memory is a taxonomy of tests that cannot fail: oracles
  // that share the defect under test, expected values derived from the code under
  // test, ratio assertions trivially true at zero. A test-only diff is exactly
  // where a second reader pays.
  assert.equal(classify(['packages/x/src/y.test.ts']).lowRisk, false);
});

test('an UNREADABLE file list is high risk, never low', () => {
  // Reading "no files" as "nothing risky" is the absence-reads-as-success shape,
  // and here it would skip real work while spending nothing.
  for (const bad of [[], null, undefined, 'docs/x.md']) {
    assert.equal(classify(bad).lowRisk, false, JSON.stringify(bad));
  }
});

test('an UNRECOGNISED path is high risk — there is no "probably fine"', () => {
  assert.equal(isLowRiskPath('some/new/thing.kt'), false);
  assert.equal(isLowRiskPath('rust/geometry/src/lib.rs'), false);
});

test('the reason names a path, so a wrong verdict can be argued with', () => {
  // A classifier that says only "high risk" cannot be checked by the person it
  // affects. Naming the file makes a misclassification reportable.
  const v = classify(['docs/a.md', 'server/api.ts']);
  assert.match(v.why, /server\/api\.ts/);
});
