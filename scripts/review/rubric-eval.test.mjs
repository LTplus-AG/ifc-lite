/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The property under test: THIS HARNESS MUST NOT FLATTER A RUBRIC. It exists to
 * decide whether a prose change recovered real recall, so the failure that would
 * make it worthless is a scorer that counts a miss as a hit -- and that is
 * exactly what a loose match would do, since both reviewers are describing the
 * same defect in different words and the temptation is to match loosely.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matches, score, validatorReason, REVIEWER_FAULT, INSTRUMENT_FAULT, JUDGE_LOG_RE } from './rubric-eval.mjs';
import { REASONS } from './validate-findings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED = {
  path: 'scripts/check-review-posted.mjs',
  what: 'headRepo !== repo compares case-sensitively and can be reached with a null repo, either of which silently disables enforcement',
};

test('a finding describing the SAME defect in different words counts as a hit', () => {
  // Two reviewers will not phrase one defect alike. Demanding they do would score
  // paraphrase rather than recall.
  const m = matches(EXPECTED, [{
    path: 'scripts/check-review-posted.mjs', line: 533,
    body: 'The comparison is case-sensitive, so a differently-cased repo reads as a fork and enforcement is disabled.',
  }]);
  assert.equal(m.hit, true, m.by ?? 'no match');
});

test('a finding in a DIFFERENT file is never a hit, however well it reads', () => {
  const m = matches(EXPECTED, [{ path: 'scripts/other.mjs', line: 1, body: 'case-sensitively disables enforcement' }]);
  assert.equal(m.hit, false);
});

test('ONE shared word is not a match — that is how a scorer flatters a rubric', () => {
  // "enforcement" alone appears in half this repository's prose. Requiring two
  // distinctive terms is what stops a vague finding scoring as a hit.
  const m = matches(EXPECTED, [{ path: EXPECTED.path, line: 533, body: 'something about enforcement here' }]);
  assert.equal(m.hit, false);
});

test('an EMPTY findings list scores zero, not an error', () => {
  const s = score([{ pr: 1, expected: [EXPECTED], verdict: 'clean', findings: [] }]);
  assert.equal(s.hits, 0);
  assert.equal(s.total, 1);
  assert.match(s.recall, /0\/1/);
  assert.ok(s.lines.some((l) => l.includes('❌ MISSED')));
});

test('EXTRA findings are counted and PRINTED, never silently penalised', () => {
  // CodeRabbit's findings are a floor, not a census: an extra may be perfectly
  // real. A harness that scored extras down would train the rubric toward
  // silence, which is the failure it exists to fix.
  const s = score([{
    pr: 1, expected: [EXPECTED], verdict: 'findings',
    findings: [{ path: 'somewhere/else.ts', line: 3, body: 'a different concern' }],
  }]);
  assert.equal(s.extra, 1);
  assert.equal(s.hits, 0, 'and it is not counted as recall');
  assert.ok(s.lines.some((l) => l.includes('➕ EXTRA')));
});

test('recall is reported as a fraction, so a change of denominator is visible', () => {
  const s = score([{ pr: 1, expected: [EXPECTED, { ...EXPECTED, what: 'unrelated thing about pagination truncation' }], verdict: 'findings', findings: [] }]);
  assert.match(s.recall, /0\/2/);
});

// ================================================ the cases are real

test('every eval case is well-formed, and an empty one is DECLARED, never inferred', () => {
  // A case file with no `expected` would quietly raise recall by shrinking the
  // denominator -- a measurement that improves by measuring less.
  //
  // Negative cases are legitimate and necessary: without PRs that SHOULD score
  // zero, the EXTRA column means nothing and a rubric change can buy recall by
  // inventing findings. But "empty means negative" is absence reading as
  // success -- a case whose findings were dropped in an edit would look
  // identical to one deliberately left empty. So a negative must say so.
  const dir = join(HERE, 'eval-cases');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no cases means a vacuous 0/0');
  let positives = 0;
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.ok(Number.isInteger(c.pr), `${f}: needs the PR it came from`);
    assert.ok(Array.isArray(c.expected), `${f}: needs an expected array`);
    if (c.negative === true) {
      assert.equal(c.expected.length, 0, `${f}: a negative case must expect nothing`);
    } else {
      assert.ok(c.expected.length > 0, `${f}: needs known findings, or "negative": true`);
      positives += 1;
    }
    assert.ok(c.input?.files?.length > 0, `${f}: needs a diff`);
    for (const e of c.expected) {
      assert.ok(
        c.input.files.some((x) => x.path === e.path),
        `${f}: expects a finding in ${e.path}, which is not in the diff`,
      );
    }
  }
  // And the set must still be mostly positive, or recall is measured over a
  // denominator small enough to move by luck.
  assert.ok(positives >= files.length / 2, `only ${positives} of ${files.length} cases carry findings`);
});

// ========================= the three ways this scorer was wrong

const E3598 = {
  path: 'scripts/check-review-posted.mjs',
  what: 'the output prints REMEDY: re-run alongside an exemption saying no re-run can clear it: two contradictory remedies',
};

test('GENERIC review vocabulary is not evidence — an unrelated finding is a MISS', () => {
  // THE BUG. `output`, `prints` and `remedy` are ordinary review words, and two
  // of them co-occurring in a finding about something else scored as recall of
  // the contradictory-remedy defect. A rubric that only got noisier would have
  // measured as recovered.
  const m = matches(E3598, [{
    path: E3598.path, line: 340,
    body: 'The renamed helper still prints the old name, so the output disagrees with the code.',
  }]);
  assert.equal(m.hit, false, `scored as a hit via ${m.by}`);
});

test('a finding QUOTING the diff does not thereby match it', () => {
  // `quote` is verbatim source from the diff under review, so folding it in made
  // a finding's own evidence count as agreement. The quote below carries BOTH
  // surviving terms for this case (`exemp`, `contr`) -- if quote were matched,
  // this unrelated finding would score as a full hit.
  const m = matches(E3598, [{
    path: E3598.path, line: 427,
    body: 'This branch is unreachable, so the code here is dead.',
    quote: "'   if (exemption.exempt) { // contradictory branch }'",
  }]);
  assert.equal(m.hit, false, `scored as a hit via ${m.by}`);
});

test('THE STEM IS CALIBRATED IN BOTH DIRECTIONS, not just the tight one', () => {
  // Seven characters lost correct findings to inflection; the fix was five. But
  // a stem can be too SHORT as well, and nothing tested that direction -- a
  // three-character stem left the whole suite green while matching almost
  // anything. `exemp`/`contr` become `exe`/`con`, and this entirely unrelated
  // finding would score as recall of the contradictory-remedy defect.
  const m = matches(E3598, [{
    path: E3598.path, line: 12,
    body: 'The executor connects to the wrong socket when the config is absent.',
  }]);
  assert.equal(m.hit, false, `an unrelated finding scored as a hit via ${m.by}`);
});

test('INFLECTION does not lose a correct finding — that is what reverts a good rubric', () => {
  // "Throwing" does not contain "throws"; "reddens" does not contain "reddeni".
  // A finding that names the defect exactly scored as MISSED, and a miss is the
  // direction that gets a rubric change reverted.
  const expected = {
    path: 'scripts/review/post-review.mjs',
    what: 'WOULD_DOWNGRADE_VERDICT throws, reddening the job for a state that needs no action and that no re-run can clear',
  };
  const m = matches(expected, [{
    path: expected.path, line: 88, class: 'Major',
    body: 'Throwing on WOULD_DOWNGRADE_VERDICT reddens the job for a benign state nobody can clear by re-running. It should log and exit 0.',
  }]);
  assert.equal(m.hit, true, 'a finding naming the defect exactly must count');
});

test('a DIFFERENT finding in the same file is an EXTRA, never silently dropped', () => {
  // The set was built from EXPECTED paths, so a second real defect in a file that
  // also held an expected one vanished: not a hit, not an extra, not printed --
  // in exactly the files a rubric change produces new findings in.
  const s2 = score([{
    pr: 3598, expected: [E3598], verdict: 'findings',
    findings: [{ path: E3598.path, line: 1, body: 'an unrelated pagination truncation bug' }],
  }]);
  assert.equal(s2.hits, 0);
  assert.equal(s2.extra, 1, 'it must be counted');
  assert.ok(s2.lines.some((l) => l.includes('➕ EXTRA')), 'and printed');
});


test('a validator refusal is blamed on the REVIEWER or the INSTRUMENT, never both', () => {
  // Every non-zero exit used to abort the whole eval as "a lane regression". Two
  // of the reasons are not that: a reviewer that answers with unanchorable quotes
  // has REVIEWED BADLY, and the honest score for it is zero findings on that PR.
  // Aborting threw away every other case and reported a broken instrument.
  //
  // Both strings below are real `validate-findings.mjs` output, produced by
  // driving it with a review whose quotes are not in the diff, and with a
  // malformed input file.
  assert.equal(validatorReason('\u274c VALIDATION_EMPTY: nothing survived.'), 'VALIDATION_EMPTY');
  assert.equal(REVIEWER_FAULT.has(validatorReason('\u274c VALIDATION_EMPTY: nothing survived.')), true);
  // RAW_EMPTY is the INSTRUMENT's side: `run-reviewer.mjs` throws EMPTY_RESPONSE
  // and exits non-zero before it writes, so the case is refused as "did not run"
  // upstream. If the validator ever sees a blank raw file, the plumbing broke.
  assert.equal(REVIEWER_FAULT.has(validatorReason('\u274c RAW_EMPTY: the raw file is blank.')), false);
  assert.equal(REVIEWER_FAULT.has(validatorReason('\u274c SCHEMA_INVALID: not an object.')), true);

  assert.equal(REVIEWER_FAULT.has(validatorReason('\u274c INPUT_INVALID: `headSha` must be 40 hex.')), false);
  assert.equal(REVIEWER_FAULT.has(validatorReason('\u274c NO_RAW: the raw file is missing.')), false);

  // An UNRECOGNISED reason must stop the eval, not be scored as a zero: a reason
  // added to the validator later would otherwise be silently absorbed as "the
  // reviewer found nothing", which is a recall number that means nothing.
  assert.equal(validatorReason('\u274c BRAND_NEW_REASON: x'), 'BRAND_NEW_REASON');
  assert.equal(REVIEWER_FAULT.has(validatorReason('\u274c BRAND_NEW_REASON: x')), false);
  assert.equal(REVIEWER_FAULT.has(validatorReason('a crash with no reason line at all')), false);
});

test('EVERY reason validate-findings can exit with is classified, or the eval stops', () => {
  // The two sets are a second copy of a list that lives in another file, and a
  // second copy held together by prose is how this drifts: a reason added to the
  // validator later falls into neither set, and the question is only whether the
  // eval NOTICES. It must, in the safe direction -- unclassified aborts the run
  // rather than being scored as "the reviewer found nothing", which would be a
  // recall number quietly computed from a case that never produced a review.
  //
  // The first version of this split classified 3 of the 7 reviewer-fault
  // reasons, so RAW_UNPARSEABLE and RESPONSE_TRUNCATED -- the two likeliest on a
  // real corpus -- still aborted the whole eval and blamed the instrument.
  // IMPORTED, not scraped. Recovering this list with a regex over the
  // validator's source failed silently in one direction: a reason spelled with a
  // digit, or in double quotes, was invisible and the count still passed.
  // validate-findings.test.mjs holds the guard that REASONS covers every raise
  // site, which is where a new reason is actually added.
  const documented = [...REASONS];
  assert.ok(documented.length >= 15, `expected the validator's reasons; found ${documented.length}`);

  const unclassified = documented.filter((r) => !REVIEWER_FAULT.has(r) && !INSTRUMENT_FAULT.has(r));
  assert.deepEqual(unclassified, [], 'every documented reason must be on one side or the other');

  const both = [...REVIEWER_FAULT].filter((r) => INSTRUMENT_FAULT.has(r));
  assert.deepEqual(both, [], 'a reason cannot be both');

  // And the sets must not name reasons the validator does not have, which is the
  // other way the copy rots.
  for (const r of [...REVIEWER_FAULT, ...INSTRUMENT_FAULT]) {
    assert.ok(REASONS.has(r), `${r} is classified here but does not exist in validate-findings.mjs`);
  }

  // The safe direction, exercised rather than asserted.
  assert.equal(REVIEWER_FAULT.has(validatorReason('\u274c A_REASON_ADDED_LATER: x')), false);
});

// ============================================ the orchestration, run for real
//
// The assertion this replaces read the harness's SOURCE and checked that the
// string `validate-findings.mjs` appeared in it. That certifies a string
// exists; it cannot show either stage runs, it is green while the behaviour is
// broken, and it reddens on a rename. It is also the pattern
// scripts/check-source-text-assertions.mjs exists to keep out -- that ratchet
// only walks `.test.ts|tsx|mts`, so no `.test.mjs` in this repo has ever been
// scanned by it, which is why the assertion landed and survived review.
//
// So the harness is driven end to end instead: a real case directory, a
// deterministic stub in place of the model, and every other stage running as a
// genuine child process. Validation is never observed directly. It is proven by
// its EFFECT -- a finding whose quote is not in the diff must not reach the
// score, and no source-level check can tell you that.

const STUB_PATCH = '@@ -1,2 +1,4 @@\n export function f(raw) {\n+  const n = Number(raw);\n+  if (n > 0) return n;\n+  return 0;\n }';

// `t.after` rather than a trailing rmSync: an assertion that throws would skip
// the latter, and a failing test is exactly when these directories pile up.
function tmpCase(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-orch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function evalCase(dir, { expected }) {
  // `expected[].what` is prose the scorer stems for terms; the shape must match
  // the real eval cases or the harness dies before the assertion is reached.
  writeFileSync(join(dir, 'case.json'), JSON.stringify({
    pr: 9001,
    expected,
    input: {
      headSha: 'a'.repeat(40),
      files: [{ path: 'src/f.ts', patch: STUB_PATCH, addedLineRanges: [[2, 4]] }],
      unreviewable: [],
      excluded: [],
    },
  }));
}

// A stub REVIEWER, not a stub validator: it writes the raw file exactly as
// run-reviewer.mjs does, fenced the way the real model fences it.
function stubReviewer(dir, body) {
  const p = join(dir, 'stub-reviewer.mjs');
  writeFileSync(p, `import { writeFileSync } from 'node:fs';
const out = process.argv[process.argv.indexOf('--out') + 1];
writeFileSync(out, ${JSON.stringify(body)});
`);
  return p;
}

const runHarness = (dir, reviewer) => spawnSync(
  process.execPath,
  // `--no-judge`, or this unit test SPAWNS THE REAL MODEL. spawnSync inherits
  // process.env, so on any machine with CLAUDE_CODE_OAUTH_TOKEN exported -- the
  // normal state for anyone working on this lane -- the harness would make a live
  // billed call and the `RECALL 1/1` assertion below would be at the judge's
  // discretion. It passes today only because an absent token fails soft. This
  // test is about the validate-then-score wiring; run-judge has its own suite.
  [join(HERE, 'rubric-eval.mjs'), '--cases', dir, '--reviewer', reviewer,
   '--rubric', join(HERE, 'rubric.md'), '--no-judge'],
  { encoding: 'utf8' },
);

const fenced = (findings, verdict = 'findings') => '```json\n' + JSON.stringify({
  verdict,
  files_reviewed: ['src/f.ts'],
  riskiest_change: { path: 'src/f.ts', quoted_line: '  if (n > 0) return n;' },
  findings,
  end: 'ifc-lite-review-v1',
}) + '\n```';

test('ONLY findings that survive validation are scored, and a FENCED response is read', (t) => {
  // Two findings, identical in shape. One quotes a line that is really in the
  // diff; the other quotes a line that is not. A harness that JSON.parsed the
  // raw output would die on the fence; one that skipped validation would score
  // both; one that discarded the validator's result would score neither.
  //
  // The COUNTS are what separate those, so they are asserted exactly. An earlier
  // version of this test matched /RECALL/, which `rubric-eval.mjs` prints on
  // every successful run -- so its positive half could not fail, and scoring
  // nothing at all passed it. That is the same defect as the source-text
  // assertion this test replaced, one level in.
  const dir = tmpCase(t);
  evalCase(dir, { expected: [{ path: 'src/f.ts', what: 'Number(raw) returns NaN so the comparison falls through and closes the session' }] });
  const reviewer = stubReviewer(dir, fenced([
    { path: 'src/f.ts', line: 3, quote: '  if (n > 0) return n;', body: 'Number(raw) returns NaN for a non-number, the comparison falls through, and closes the session.', class: 'numeric-bound' },
    { path: 'src/f.ts', line: 3, quote: '  this line is nowhere in the diff', body: 'a fabricated anchor', class: 'numeric-bound' },
  ]));
  const r = runHarness(dir, reviewer);
  const said = `${r.stdout}${r.stderr}`;

  assert.equal(r.status, 0, said);
  // Exactly one finding survived, it was the real one, and it was RECOGNISED.
  assert.match(said, /RECALL of known findings: 1\/1/, said);
  assert.match(said, /EXTRA findings[^:]*: 0/, said);
  // The drop names the FABRICATED quote, not merely the word DROPPED, which the
  // whole-output echo on the failure path also satisfies.
  assert.match(said, /DROPPED[\s\S]*this line is nowhere in the diff/, said);
  assert.doesNotMatch(said, /a fabricated anchor/, 'a finding that failed validation must not reach the score');
});

test('a response where NOTHING survives scores ZERO and the eval CARRIES ON', (t) => {
  // VALIDATION_EMPTY is the reviewer answering badly, not the harness breaking.
  // Aborting here threw away every other case and reported a broken instrument.
  const dir = tmpCase(t);
  evalCase(dir, { expected: [{ path: 'src/f.ts', what: 'Number(raw) returns NaN and the comparison falls through, closing the session' }] });
  const reviewer = stubReviewer(dir, fenced([
    { path: 'src/f.ts', line: 3, quote: '  not in the diff at all', body: 'x', class: 'numeric-bound' },
  ]));
  const r = runHarness(dir, reviewer);
  const said = `${r.stdout}${r.stderr}`;

  assert.equal(r.status, 0, `the eval must finish and report a score:\n${said}`);
  assert.match(said, /VALIDATION_EMPTY/, said);
  assert.match(said, /scored ZERO/, said);
  assert.match(said, /PRODUCED NO USABLE REVIEW/, 'the recall line must say how many cases produced nothing');
});

test('an EMPTY response is a HARD ERROR, because the real chain cannot produce one', (t) => {
  // Not "the model said nothing, score it zero". `run-reviewer.mjs` throws
  // EMPTY_RESPONSE and exits non-zero on empty output, so through the real chain
  // this case is refused as "did not run" long before the validator sees it. A
  // blank raw file reaching validation means the plumbing broke, and the earlier
  // version of this test asserted a property of the STUB rather than of the lane
  // -- it reached RAW_EMPTY only because a stub can exit 0 with an empty file,
  // which run-reviewer cannot.
  const dir = tmpCase(t);
  evalCase(dir, { expected: [{ path: 'src/f.ts', what: 'Number(raw) returns NaN so the comparison falls through and closes the session' }] });
  const r = runHarness(dir, stubReviewer(dir, ''));
  const said = `${r.stdout}${r.stderr}`;

  assert.notEqual(r.status, 0, `an empty response must not produce a score:\n${said}`);
  assert.match(said, /RAW_EMPTY/, said);
  assert.doesNotMatch(said, /RECALL of known findings/, 'no recall number may be printed from a run that produced nothing');
});

test('a VALIDATION failure on the harness\'s own input is a HARD ERROR', (t) => {
  // The other side of the split, and the one that must never be scored: if the
  // input WE built is refused, nothing about the rubric can be read off the run.
  // Reporting a low recall here would blame the reviewer for our own bug.
  const dir = tmpCase(t);
  evalCase(dir, { expected: [{ path: 'src/f.ts', what: 'Number(raw) returns NaN and the comparison falls through, closing the session' }] });
  const bad = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
  bad.input.headSha = 'not-a-sha';
  writeFileSync(join(dir, 'case.json'), JSON.stringify(bad));

  const reviewer = stubReviewer(dir, fenced([
    { path: 'src/f.ts', line: 3, quote: '  if (n > 0) return n;', body: 'Number(raw) is NaN, so this returns 0.', class: 'numeric-bound' },
  ]));
  const r = runHarness(dir, reviewer);
  const said = `${r.stdout}${r.stderr}`;

  assert.notEqual(r.status, 0, `an INPUT_INVALID refusal must stop the run:\n${said}`);
  assert.match(said, /INPUT_INVALID/, said);
  assert.doesNotMatch(said, /RECALL of known findings/, 'no recall number may be printed from a run that did not happen');
});

test('a finding that only PARAPHRASES THE PR BODY does not score as recall', () => {
  // The body is handed to the reviewer, so crediting it for repeating the body
  // measures copying. This is the same rule that already excludes `quote`: a
  // harness that credits a reviewer for quoting its own input measures nothing.
  const expected = {
    path: 'apps/a/resolve.ts',
    what: 'the helper returns an empty array where the description promises a null sentinel, so callers cannot distinguish unresolved from resolved-to-nothing',
  };
  const body = 'This PR introduces a null sentinel meaning the helper cannot answer yet, and describes what callers should do.';

  // A reviewer that read only the description and echoed it back.
  const parrot = [{ path: 'apps/a/resolve.ts', line: 3, body: 'The description promises a null sentinel meaning it cannot answer yet.', class: 'x' }];
  assert.equal(matches(expected, parrot, body).hit, false, 'echoing the body is not a finding');
  assert.equal(matches(expected, parrot, null).hit, true, 'and without the exclusion it would have scored');

  // A reviewer that actually looked at the code.
  const real = [{ path: 'apps/a/resolve.ts', line: 3, body: 'This returns [] so callers cannot distinguish unresolved from resolved-to-nothing.', class: 'x' }];
  assert.equal(matches(expected, real, body).hit, true, 'the code vocabulary still scores');
});

test('the EVAL workflow asks for a context pack too', () => {
  // `--base` is explicit by design, so that the diff-only baseline stays
  // reproducible. The cost of that choice is that the flag can go missing without
  // anything failing -- which is exactly what happened when the default was
  // removed and the only automated caller was not updated.
  const yml = readFileSync(join(HERE, '..', '..', '.github/workflows/rubric-eval.yml'), 'utf8');
  // Every invocation, not the first mention: see the same note in
  // build-review-input.test.mjs.
  const windows = [];
  // A missing CLI flag in YAML has no behaviour to test, and its absence silently
  // disabled the context pack in production. The file's text IS the mechanism.
  for (let i = yml.indexOf('rubric-eval.mjs'); i !== -1; i = yml.indexOf('rubric-eval.mjs', i + 1)) { // @source-text-assertion-ok a workflow flag has no behaviour to assert on; its absence is the defect
    windows.push(yml.slice(i, i + 400));
  }
  assert.ok(windows.length > 0, 'the eval workflow must invoke rubric-eval');
  const calls = windows.filter((w) => w.includes('--rubric '));
  assert.ok(calls.length > 0, 'no window looks like an invocation (none carries --rubric)');
  for (const call of calls) {
    assert.match(call, /--base /, 'the eval would silently score the diff-only baseline');
  }
});

test('the eval reports a CLEAN judging, not only a lossy one', () => {
  // The filter was /JUDGE (DROPPED|UNAVAILABLE|NOTE)|CAPPED/, so a judge that ran
  // and removed nothing -- which prints only `JUDGE: n in, n out` -- produced no
  // output whatsoever. A whole CI eval then could not answer "did the judge run",
  // and I misread one such log as the judge having eaten a finding when it had
  // run and dropped none. An instrument has to report doing nothing.
  // THE SHIPPED regex, imported. Inlining a copy here made this test pass while
  // the source reverted to the narrow pattern -- it guarded nothing.
  const shown = (l) => JUDGE_LOG_RE.test(l);
  assert.equal(shown('JUDGE: 3 in, 3 out.'), true, 'a clean judging must appear');
  assert.equal(shown('JUDGE DROPPED a.ts:1 -- vague'), true);
  assert.equal(shown('JUDGE UNAVAILABLE: quota drained'), true);
  assert.equal(shown('JUDGE NOTE: keeping all findings'), true);
  assert.equal(shown('CAPPED: 7 findings, posting 5'), true);
  assert.equal(shown('some unrelated reviewer output'), false, 'and it must not print everything');
});
