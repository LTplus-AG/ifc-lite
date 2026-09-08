/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Regression harness for `./partial-close-admission.mjs`.
 *
 * FIXTURE BODIES ARE REAL, adapted from PRs #4154 itself investigated
 * (#4114, #4082, #4133, #4134). #4114's is verbatim and still live at the
 * time this test was written (`Closes #4111 (item 1 only)`, unedited). The
 * other three were later edited from `Closes`/bare closing prose to `Refs`
 * (#4154's own body documents this), so their fixtures below restore the
 * ORIGINAL closing form for the `closesAnyIssue: true` cases -- everything
 * after the opening keyword is the PR's real, current prose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAdmissionPhrases, evaluatePartialCloseAdmission } from './partial-close-admission.mjs';

// #4114 -> #4111, verbatim, still live.
const PR_4114_BODY =
  'Closes #4111 (item 1 only).\n\n' +
  '`apps/viewer/public/` is 6.13 MB across 31 files... Five files are linked by nothing.\n\n' +
  '## Not in this PR\n\n- dedupe the logo\n- add an asset-usage gate\n';

// #4082 -> #4053, original closing form restored (issue #4154 documents the
// edit: "first version ... read `Closes #4053 (residual 1 ...)`").
const PR_4082_BODY =
  'Closes #4053 (residual 1 — attribute-index parity, #3949\'s shape). This PR does not address ' +
  '#4053\'s other two items: Residual 2 (behavioural/spatial-promotion parity, #3965\'s shape) or ' +
  'the classifications scope decision (#3948/#3955\'s shape) -- both remain open.\n\n' +
  '#3979\'s type-name-set parity harness cannot see this shape at all.';

// #4133 -> #4099, original closing form restored.
const PR_4133_BODY =
  'Closes #4099 — load-order guidance is done.\n\n' +
  '## Context\n\nThe issue has two halves. This PR addresses the concrete, substantive one (load ' +
  'order) and does the defensible low-risk part of the discoverability half; it deliberately ' +
  'leaves the rest of discoverability to the maintainer.\n\n' +
  '## (a) Load-order guidance — implemented\n\nA BCF\'s topics reference GlobalIds...';

// #4134 -> #4116, original closing form restored. The admission ("not
// attempted") sits in a "Scope note" far from the top-line closing keyword --
// this is the fixture #4154's own investigation names as the case a
// same-paragraph scope would miss.
const PR_4134_BODY =
  'Closes #4116. This fixes the harness-level symptom (the browser-close hang is now bounded and ' +
  'reported instead of hanging indefinitely), but it does not perform the fixture-size root-cause ' +
  'investigation #4116 asked for — see the Scope note below.\n\n' +
  '`scripts/perf/browser-cold-ab.mts`\'s teardown did `await x.close().catch(...)` for both the ' +
  'Playwright `BrowserContext` and `Browser`.\n\n' +
  '## Fix\n\nNew `scripts/perf/browser-cold-teardown.ts` exports `closeContextWithTimeout` / ' +
  '`closeBrowserWithTimeout`...\n\n' +
  '## Scope note\n\n' +
  'Full-fixture-size confirmation (the actual 1.26 GB model against a real browser hang) was not ' +
  'attempted — fetching and running that repeatedly was judged disproportionate for verifying a ' +
  'harness-teardown fix whose mechanism (an unresolved `close()` promise) is fully reproducible ' +
  'at small scale.';

// -------------------------------------------------------------- findAdmissionPhrases

test('findAdmissionPhrases: finds the admission in each of the four confirmed PR bodies', () => {
  assert.ok(findAdmissionPhrases(PR_4114_BODY).includes('(item N only)'));
  assert.ok(findAdmissionPhrases(PR_4082_BODY).includes('does not address'));
  assert.ok(findAdmissionPhrases(PR_4133_BODY).includes('deliberately leaves'));
  assert.ok(findAdmissionPhrases(PR_4134_BODY).includes('not attempted'));
});

test('findAdmissionPhrases: no admission phrase -> empty', () => {
  assert.deepEqual(findAdmissionPhrases('Closes #100. Fixes the off-by-one in the exporter.'), []);
});

test('findAdmissionPhrases: an admission phrase inside a fenced code block is not found', () => {
  const body = 'Closes #100. Normal PR.\n\n```\nCloses #200 (item 1 only)\n```\n';
  assert.deepEqual(findAdmissionPhrases(body), []);
});

test('findAdmissionPhrases: an admission phrase inside an inline code span is not found', () => {
  const body = 'Closes #100. See `(item 1 only)` in the old commit message for context.';
  assert.deepEqual(findAdmissionPhrases(body), []);
});

test('findAdmissionPhrases: an admission phrase inside a blockquote is not found', () => {
  const body = 'Closes #100.\n\n> does not address the rest\n';
  assert.deepEqual(findAdmissionPhrases(body), []);
});

test('findAdmissionPhrases: is case-insensitive and word-bounded', () => {
  assert.ok(findAdmissionPhrases('OUT OF SCOPE for this PR.').includes('out of scope'));
  // "impartially" must not match "partially".
  assert.deepEqual(findAdmissionPhrases('Handled impartially by the reviewer.'), []);
});

// ------------------------------------------------------- evaluatePartialCloseAdmission

test('evaluate: bare Closes #N + admission phrase -> warns, for all four confirmed shapes', () => {
  for (const body of [PR_4082_BODY, PR_4133_BODY, PR_4134_BODY]) {
    const r = evaluatePartialCloseAdmission({ body, closesAnyIssue: true });
    assert.equal(r.warn, true);
    assert.equal(r.verdict, 'PARTIAL_CLOSE_ADMISSION');
    assert.ok(r.matches.length > 0);
  }
  const r4114 = evaluatePartialCloseAdmission({ body: PR_4114_BODY, closesAnyIssue: true });
  assert.equal(r4114.warn, true);
  assert.ok(r4114.matches.includes('(item N only)'));
});

test('evaluate: Closes #N with no admission -> silent', () => {
  const r = evaluatePartialCloseAdmission({
    body: 'Closes #100. Fixes the off-by-one in the exporter. Fully covers the issue.',
    closesAnyIssue: true,
  });
  assert.equal(r.warn, false);
  assert.equal(r.verdict, 'CLEAN');
});

test('evaluate: admission phrase present but no closing keyword -> silent', () => {
  const r = evaluatePartialCloseAdmission({
    body: 'Refs #100. This PR does not address the second item; it remains open for a follow-up.',
    closesAnyIssue: false,
  });
  assert.equal(r.warn, false);
  assert.equal(r.verdict, 'NO_CLOSING_KEYWORD');
  assert.deepEqual(r.matches, []);
});

test('evaluate: admission phrase inside a fenced code block, with a real Closes -> silent', () => {
  const body = 'Closes #100.\n\n```\nthis PR does not address the rest\n```\n';
  const r = evaluatePartialCloseAdmission({ body, closesAnyIssue: true });
  assert.equal(r.warn, false);
  assert.equal(r.verdict, 'CLEAN');
});

test('evaluate: Refs #N with an admission -> silent (not a closing claim)', () => {
  // Mirrors #4147's honest-partial-work shape: the PR never claims to close
  // anything, so `closesAnyIssue` is false regardless of what the body says.
  const r = evaluatePartialCloseAdmission({ body: PR_4082_BODY.replace(/^Closes/, 'Refs'), closesAnyIssue: false });
  assert.equal(r.warn, false);
  assert.equal(r.verdict, 'NO_CLOSING_KEYWORD');
});

test('evaluate: warning lines name the matched phrases and say it does not fail the build', () => {
  const r = evaluatePartialCloseAdmission({ body: PR_4114_BODY, closesAnyIssue: true });
  const joined = r.lines.join('\n');
  assert.match(joined, /\(item N only\)/);
  assert.match(joined, /does not block merge/);
  assert.match(joined, /cannot catch a PR that partly closes an issue and says nothing/);
});
