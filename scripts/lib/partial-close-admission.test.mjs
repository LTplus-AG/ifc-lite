/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Regression harness for `./partial-close-admission.mjs`.
 *
 * FIXTURE PROVENANCE, RECHECKED AGAINST `userContentEdits` (adversarial
 * review of #4180, 2026-09-08). Each PR below carries a real GraphQL edit
 * history; `gh api graphql` was used to read it directly rather than trust
 * a prior summary.
 *
 *  - #4114: the CURRENT, live body -- never edited in substance (two
 *    `userContentEdits`, both cosmetic). `Closes #4111 (item 1 only)`
 *    verbatim.
 *  - #4082: THE PAIRING THIS FIXTURE PREVIOUSLY CLAIMED NEVER EXISTED. The
 *    real history has FIVE edits. Every edit while the body still read
 *    `Closes #4053` (2026-09-07T07:14:53Z through T10:27:11Z) carried ONLY
 *    `(residual 1 -- attribute-index parity, #3949's shape)` -- no "does not
 *    address" sentence, no "remain open". That sentence was added in the
 *    SAME edit (2026-09-08T08:06:21Z) that switched `Closes` to `Refs`. A
 *    `Closes #4053` + "does not address ... remain open" body was never
 *    live. The fixture below is now the real ORIGINAL `Closes` body
 *    (verbatim, elided only at paragraph boundaries) -- its actual
 *    admission signal is `residual 1`, an enumerated-item admission of the
 *    #4114 `(item N only)` shape, not the "does not address" sentence this
 *    file previously fabricated.
 *  - #4133: the real original `Closes #4099` body (2026-09-08T04:30:29Z)
 *    DOES pair a bare `Closes` with "it deliberately leaves the rest of
 *    discoverability to the maintainer" -- that pairing is real. The
 *    fixture previously grafted "-- load-order guidance is done." onto the
 *    `Closes #4099` opening line; that clause is real text, but it was
 *    added in the LATER edit that also switched to `Refs`, so it never
 *    literally followed `Closes #4099` the way the old fixture wrote it.
 *    Fixed below to the real original opening line.
 *  - #4134: the real original `Closes #4116.` body (2026-09-08T04:33:15Z)
 *    DOES carry "was not attempted" in a "Scope note" near the bottom --
 *    real, unedited across all three revisions. The fixture previously
 *    grafted a summary sentence ("This fixes the harness-level symptom...")
 *    onto the `Closes #4116.` opening line; that sentence, too, was only
 *    added in the edit that switched to `Refs`. Fixed below to the real
 *    original opening line.
 *
 * Net effect on "how many of the four real historical Closes-bodies does
 * the gate catch": still 4 of 4 -- #4082's real signal is `residual 1`
 * rather than "does not address", but it is a real signal in the real
 * original body, not a fabricated one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAdmissionPhrases, evaluatePartialCloseAdmission } from './partial-close-admission.mjs';

// #4114 -> #4111, verbatim, still live, unedited in substance.
const PR_4114_BODY =
  'Closes #4111 (item 1 only).\n\n' +
  '`apps/viewer/public/` is 6.13 MB across 31 files... Five files are linked by nothing.\n\n' +
  '## Not in this PR\n\n- dedupe the logo\n- add an asset-usage gate\n';

// #4082 -> #4053, the REAL original body (2026-09-07T07:14:53Z), elided only
// at paragraph boundaries. "does not address ... remain open" is NOT here --
// see the file header for why that sentence never coexisted with `Closes`.
const PR_4082_BODY =
  '## Summary\n\n' +
  "Closes #4053 (residual 1 — attribute-index parity, #3949's shape).\n\n" +
  "#3979's type-name-set parity harness cannot see this shape at all: #3949 was\n" +
  'the server reading `GlobalId`/`Name` at hardcoded `IfcRoot` positions (0/2)\n' +
  'while the browser resolved every type by its own schema attribute name — both\n' +
  'sides already agree on the type *name*, the divergence was purely which\n' +
  'attribute slot each side reads.';

// #4133 -> #4099, the REAL original opening line (2026-09-08T04:30:29Z) --
// no "-- load-order guidance is done." grafted on; that clause postdates
// the switch to `Refs`. Everything from "## Context" on is real and
// unedited.
const PR_4133_BODY =
  'Closes #4099\n\n' +
  '## Context\n\nThe issue has two halves. This PR addresses the concrete, substantive one (load ' +
  'order) and does the defensible low-risk part of the discoverability half; it deliberately ' +
  'leaves the rest of discoverability to the maintainer.\n\n' +
  '## (a) Load-order guidance — implemented\n\nA BCF\'s topics reference GlobalIds...';

// #4134 -> #4116, the REAL original opening line (2026-09-08T04:33:15Z) --
// no "This fixes the harness-level symptom..." grafted on; that sentence
// postdates the switch to `Refs`. The "Scope note" section (where "not
// attempted" lives) is real and unedited across all three revisions -- this
// is still the fixture #4154's own investigation names as the case a
// same-paragraph scope would miss.
const PR_4134_BODY =
  'Closes #4116.\n\n' +
  '`scripts/perf/browser-cold-ab.mts`\'s teardown did `await x.close().catch(...)` for both the ' +
  'Playwright `BrowserContext` and `Browser`.\n\n' +
  '## Fix\n\nNew `scripts/perf/browser-cold-teardown.ts` exports `closeContextWithTimeout` / ' +
  '`closeBrowserWithTimeout`...\n\n' +
  '## Scope note\n\n' +
  'Full-fixture-size confirmation (the actual 1.26 GB model against a real browser hang) was not ' +
  'attempted — fetching and running that repeatedly was judged disproportionate for verifying a ' +
  'harness-teardown fix whose mechanism (an unresolved `close()` promise) is fully reproducible ' +
  'at small scale.';

// The real body of #4180 itself (this gate's own introducing PR), fetched
// via `gh api repos/LTplus-AG/ifc-lite/pulls/4180 --jq '.body'` on
// 2026-09-08. THE PROOF CASE for finding A: its own CI run warned on this
// body, matching `follow-up` against the sentence below that is explaining
// -- in prose -- the false-positive risk of the `follow-up` phrase. A gate
// that fires on its own design-rationale paragraph is not usable, and no
// synthetic fixture stands in for this: it must be the real body.
const PR_4180_OWN_BODY =
  "Closes #4154\n\n`Closes #N` closes the issue on merge and GitHub's keyword scanner ignores any qualifier after the number, so `Closes #4111 (item 1 only)` closed #4111 in full with two of its three items undone (#4114); the remainder needed a second PR (#4139). Three more PRs the same day (#4082, #4133, #4134) carried the same shape before a human caught it and reworded to `Refs`.\n\n## What this adds\n\n`scripts/check-partial-close-admission.mjs` (+ `scripts/lib/partial-close-admission.mjs`), wired alongside `check-issue-queue.mjs` in `issue-queue.yml`. It reuses `closingIssuesReferences` -- the field GitHub itself acts on, already read by `check-issue-queue.mjs` -- to answer \"does this PR close something\", and adds one new read: does the body also contain an admission-of-partial-coverage phrase (`(item N only)`, `only the`, `does not address`, `deliberately leaves`, `leaves the rest`, `remains open`, `out of scope`, `residual`, `follow-up`, `not attempted`, `partially`).\n\n## Scope decision: whole-body, not same-paragraph\n\nThe issue itself flags this as unsettled. Of the four confirmed PRs, #4114 and #4082 have the admission in the same sentence as the closing keyword, #4133 has it two paragraphs later, and #4134 has it in a \"Scope note\" near the *bottom* of a long body, nowhere near the top-line `Closes #4116`. Same-paragraph scope catches 3 of 4; whole-body catches all 4. I chose whole-body because a missed admission is a silent failure of the thing this gate exists to catch, and the cost of the alternative failure mode -- a false positive -- is low here: this gate **warns, it never fails the build**, per the issue's own recommendation. The tradeoff is real and not hidden: a PR that closes its issue completely and separately notes an unrelated \"follow-up\" about future work will be flagged.\n\n## What it cannot catch\n\nA PR that partly closes an issue and says nothing about it sails through untouched -- silence is invisible to a phrase scan, and always will be. This narrows the problem, it does not solve it.\n\n## Reuse\n\n`stripNonProse` (fenced-code / inline-span / blockquote stripping) is imported from `scripts/lib/issue-refs.mjs` (#4161), exported from that module rather than duplicated, so a `Closes #N (item 1 only)` quoted inside a code fence can't trigger the warning.\n\n## Tests\n\n`scripts/lib/partial-close-admission.test.mjs` and `scripts/check-partial-close-admission.test.mjs` cover: a bare `Closes #N` + admission → warns (using the four real PR bodies, restoring their original `Closes` wording per this issue's own documented edit history, since three were later reworded to `Refs`); `Closes #N` with no admission → silent; an admission with no closing keyword → silent; an admission inside a fenced code block → silent; `Refs #N` with an admission → silent (not a closing claim); a missing/malformed payload → refuses (exit 1), distinct from a clean verdict (exit 0).\n\n**Mutation-tested**: disabling the admission-phrase scan turned 5 tests red; disabling the shared fenced-code stripper (in `issue-refs.mjs`) turned 7 tests red across both suites. Reverting both restores 126/126 green. Confirmed each mutation actually applied via `diff` against the pre-mutation file.\n\n## Gates run locally\n\n- `node --test scripts/lib/partial-close-admission.test.mjs scripts/check-partial-close-admission.test.mjs scripts/lib/issue-refs.test.mjs scripts/check-issue-queue.test.mjs` → 126/126 pass\n- `node scripts/check-test-wiring.mjs` → OK\n- `node scripts/check-module-size.mjs` → OK, no new file over budget\n- `node scripts/check-source-text-assertions.mjs` → OK, 0 new\n";

// -------------------------------------------------------------- findAdmissionPhrases

test('findAdmissionPhrases: finds the admission in each of the four confirmed PR bodies', () => {
  assert.ok(findAdmissionPhrases(PR_4114_BODY).includes('(item N only)'));
  // #4082's real original body's admission is the enumerated `residual 1`,
  // not "does not address" -- see the file header. That sentence was never
  // live alongside `Closes`.
  assert.ok(findAdmissionPhrases(PR_4082_BODY).includes('residual N'));
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

// FINDING F: blockquote text is NOT stripped for this gate (unlike
// issue-refs.mjs's REF_KEYWORD_RE, which this scan deliberately does not
// share that step with -- see ./partial-close-admission.mjs's header for
// the reasoning). An author quoting a reviewer's "this only covers X"
// observation is still admitting it into the PR's own record.
test('findAdmissionPhrases: an admission phrase inside a blockquote IS found (quoting it is not hiding it)', () => {
  const body = 'Closes #100.\n\n> does not address the rest\n';
  assert.deepEqual(findAdmissionPhrases(body), ['does not address']);
});

test('findAdmissionPhrases: is case-insensitive and word-bounded', () => {
  assert.ok(findAdmissionPhrases('OUT OF SCOPE for this PR.').includes('out of scope'));
  // "impartially" must not match "partially".
  assert.deepEqual(findAdmissionPhrases('Handled impartially by the reviewer.'), []);
});

// ------------------------------------------- FINDING A: the self-fire proof case

test('findAdmissionPhrases: does NOT fire on #4180\'s own real body (the proof case)', () => {
  assert.deepEqual(findAdmissionPhrases(PR_4180_OWN_BODY), []);
});

test('evaluate: #4180\'s own real body, with its own real closing keyword, is CLEAN', () => {
  const r = evaluatePartialCloseAdmission({ body: PR_4180_OWN_BODY, closesAnyIssue: true });
  assert.equal(r.warn, false);
  assert.equal(r.verdict, 'CLEAN');
});

// ---------------------------------------- FINDING A: `only the` removed entirely

test('findAdmissionPhrases: "only the" in ordinary prose is not an admission phrase', () => {
  // The two demonstrated false positives from the adversarial review: a
  // synthetic "touches only the parser module" and #4082's own real
  // CodeRabbit-generated summary line "Only the one hand-picked Rust
  // fixture (`IfcClassification`) ... happens to catch it".
  assert.deepEqual(findAdmissionPhrases('This change touches only the parser module.'), []);
  assert.deepEqual(
    findAdmissionPhrases(
      'Only the one hand-picked Rust fixture (`IfcClassification`) in the test suite happens to catch it.',
    ),
    [],
  );
});

// -------------------------------------- FINDING A: `residual` requires enumeration

test('findAdmissionPhrases: a numerical "residual" (e.g. floating-point) is not an admission phrase', () => {
  assert.deepEqual(
    findAdmissionPhrases('The solver converged once the residual error dropped below 1e-6.'),
    [],
  );
});

test('findAdmissionPhrases: "residual N" (an enumerated remaining-item admission) still matches', () => {
  assert.ok(findAdmissionPhrases('This PR covers residual 1 of #4053; residual 2 is not attempted here.').includes('residual N'));
});

// -------------------------------------- FINDING A: `follow-up` requires a heading

test('findAdmissionPhrases: an inline "follow-up" mention is not an admission phrase', () => {
  // This is the literal shape that fired on #4180 itself.
  assert.deepEqual(
    findAdmissionPhrases('a PR that separately notes an unrelated "follow-up" about future work will be flagged.'),
    [],
  );
});

test('findAdmissionPhrases: a "## Follow-up" section heading still matches', () => {
  const body = 'Closes #100.\n\n## Follow-up\n\n- consider caching this\n';
  assert.ok(findAdmissionPhrases(body).includes('follow-up (heading)'));
});

// ------------------------------------------------------------ FINDING D: boundaries

test('findAdmissionPhrases: word-boundary regression coverage for every surviving short phrase', () => {
  // Each of these constructs a superstring of the phrase that must NOT
  // match -- if a future edit strips the phrase's `\b`, one of these goes
  // from [] to a false match.
  assert.deepEqual(findAdmissionPhrases('This PR is not addressable by a simple patch.'), []);
  assert.deepEqual(findAdmissionPhrases('The team deliberately leavesment was unrelated.'), []);
  assert.deepEqual(findAdmissionPhrases('The dog leaves the resting place undisturbed.'), []);
  assert.deepEqual(findAdmissionPhrases('The door remains opened at all times.'), []);
  assert.deepEqual(findAdmissionPhrases('This is out of scoped territory.'), []);
  assert.deepEqual(findAdmissionPhrases('The nonresidual 2 component was measured.'), []);
  assert.deepEqual(findAdmissionPhrases('It was not attemptedly finished.'), []);
  assert.deepEqual(findAdmissionPhrases('## Follow-ups planned for later.'), []);
  assert.deepEqual(findAdmissionPhrases('(item 12 onlyish thing)'), []);
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
  const r = evaluatePartialCloseAdmission({ body: PR_4082_BODY.replace(/^## Summary\n\nCloses/, '## Summary\n\nRefs'), closesAnyIssue: false });
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
