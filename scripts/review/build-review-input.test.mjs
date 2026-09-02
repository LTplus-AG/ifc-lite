/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `addedLineRanges` is the one function here whose correctness is load-bearing
 * downstream: validate-findings.mjs refuses any finding whose line falls outside
 * a range this produces, so a bug here either silently drops real findings or
 * lets hallucinated line numbers through. It is tested against hand-checked
 * hunks rather than a fixture, because a fixture generated from this function
 * would agree with it whatever it does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync , readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedLineRanges, newFileLines, buildInput, isExcluded, MAX_PATCH_BYTES } from './build-review-input.mjs';
import { pageAll as pageFiles } from '../check-review-posted.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'build-review-input.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'review-input-'));
const SHA = 'a'.repeat(40);
let seq = 0;

const run = (rows, extra = []) => {
  const f = join(TMP, `files-${(seq += 1)}.json`);
  const out = join(TMP, `out-${seq}.json`);
  writeFileSync(f, JSON.stringify(rows));
  const r = spawnSync(process.execPath, [SCRIPT, '--sha', SHA, '--files-file', f, '--out', out, ...extra], {
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, result: r.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null };
};

// ======================================================== addedLineRanges

test('a single added block yields one range', () => {
  // +10,+11,+12 are added; the hunk starts the new file at line 10.
  const patch = '@@ -1,2 +10,5 @@\n context\n+added one\n+added two\n context';
  // line 10 is ' context', 11 and 12 are the additions.
  assert.deepEqual(addedLineRanges(patch), [[11, 12]]);
});

test('two separated blocks yield two ranges', () => {
  const patch = ['@@ -1,4 +1,6 @@', ' a', '+x', ' b', ' c', '+y', ' d'].join('\n');
  // new file: 1=' a', 2='+x', 3=' b', 4=' c', 5='+y', 6=' d'
  assert.deepEqual(addedLineRanges(patch), [[2, 2], [5, 5]]);
});

test('removed lines do not advance the new-file counter', () => {
  const patch = ['@@ -1,3 +1,2 @@', ' a', '-gone', '+new'].join('\n');
  // new file: 1=' a', then '-gone' consumes nothing, 2='+new'
  assert.deepEqual(addedLineRanges(patch), [[2, 2]]);
});

test('multiple hunks each restart at their own header', () => {
  const patch = ['@@ -1,1 +1,2 @@', ' a', '+b', '@@ -50,1 +51,2 @@', ' c', '+d'].join('\n');
  assert.deepEqual(addedLineRanges(patch), [[2, 2], [52, 52]]);
});

test('a `+++` header line is not counted as an addition', () => {
  const patch = ['+++ b/file.ts', '@@ -1,1 +1,2 @@', ' a', '+real'].join('\n');
  const ranges = addedLineRanges(patch);
  assert.deepEqual(ranges, [[2, 2]], 'only the real addition counts');
});

test('the no-newline marker is metadata, not a context line', () => {
  // Counting it shifted every later range by one: a correct finding on the real
  // line was dropped as out-of-range, and a finding one past EOF was posted and
  // rejected 422. Fires on any file without a trailing newline.
  const patch = ['@@ -1,3 +1,4 @@', ' a', ' b', '-c', '\\ No newline at end of file', '+c', '+d', '\\ No newline at end of file'].join('\n');
  // new file: 1=' a', 2=' b', then '-c' consumes nothing, 3='+c', 4='+d'
  assert.deepEqual(addedLineRanges(patch), [[3, 4]]);
});

// ============================================================== exclusions

test('generated and vendored paths are excluded', () => {
  for (const p of ['pnpm-lock.yaml', 'Cargo.lock', 'packages/x/__snapshots__/a.snap', 'tests/fixtures/a.ts', 'packages/wasm/pkg/x.d.ts', 'docs/a.png', 'scripts/api-surface.json', 'scripts/review/eval-cases/pr-3595.json']) {
    assert.equal(isExcluded(p), true, `${p} should be excluded`);
  }
});

test('real source is NOT excluded', () => {
  for (const p of ['packages/export/src/step.ts', 'rust/geometry/src/lib.rs', 'scripts/check-x.mjs']) {
    assert.equal(isExcluded(p), false, `${p} must be reviewed`);
  }
});

// ================================================= what is recorded, not dropped

test('a file with no patch is recorded as unreviewable, never silently absent', () => {
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    { filename: 'src/huge.ts', status: 'modified' },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.result.files.length, 1);
  // Structured, not an annotated string: the validator refuses an input where a
  // path is in both `files` and `unreviewable`, and against a string like
  // "src/huge.ts (too large)" that check can never match.
  assert.deepEqual(r.result.unreviewable[0], { path: 'src/huge.ts', reason: 'no patch returned (too large, or a pure rename)' });
  assert.match(r.out, /NOT shown to the reviewer/);
});

test('a deleted file is unreviewable, not a phantom clean file', () => {
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-a\n-b' },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.result.unreviewable[0], { path: 'src/gone.ts', reason: 'deleted' });
});

// ============================================================ refusals

test('NO_FILES refuses rather than emitting an empty review input', () => {
  // A reviewer handed an empty input reports it clean, confidently. That is the
  // absence-reads-as-success shape, one layer below where it usually appears.
  const r = run([{ filename: 'pnpm-lock.yaml', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NO_FILES/);
});

test('REVIEW_TOO_LARGE refuses rather than reviewing a prefix', () => {
  const big = `@@ -1,1 +1,2 @@\n a\n+${'x'.repeat(MAX_PATCH_BYTES)}`;
  const r = run([{ filename: 'src/big.ts', status: 'modified', patch: big }]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /REVIEW_TOO_LARGE/);
  assert.match(r.out, /split the PR/);
});

test('a bad --sha is refused', () => {
  const f = join(TMP, 'f.json');
  writeFileSync(f, JSON.stringify([{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1,2 @@\n a\n+b' }]));
  const r = spawnSync(process.execPath, [SCRIPT, '--sha', 'nope', '--files-file', f, '--out', join(TMP, 'o.json')], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /NO_SHA/);
});

// ================================================================== paging

test('the pager stops at a short page and reports a complete read', () => {
  const pages = { 1: Array(100).fill({ filename: 'a' }), 2: [{ filename: 'b' }] };
  const seen = [];
  const r = pageFiles((p) => { seen.push(p); return pages[p] ?? []; });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(r.truncated, false);
  assert.equal(r.rows.length, 101);
});

test('a file list past the page budget reports truncated, and the caller refuses', () => {
  const r = pageFiles(() => Array(10).fill({ filename: 'a' }), { maxPages: 3, perPage: 10 });
  assert.equal(r.truncated, true);
});

test('an EXACTLY full file list is a complete read, not a refusal', () => {
  // The reason this uses the gate's pager rather than a local copy: the local
  // one lacked the probe past a full final page, so a PR with exactly
  // maxPages x perPage files was fully read and then refused as truncated.
  const r = pageFiles((page) => (page <= 3 ? Array(10).fill({ filename: 'a' }) : []), { maxPages: 3, perPage: 10 });
  assert.equal(r.truncated, false);
  assert.equal(r.rows.length, 30);
});

test('a non-array page is BAD_PAYLOAD, not an empty read', () => {
  assert.throws(() => pageFiles(() => ({})), (e) => e.reason === 'BAD_PAYLOAD');
});

// =========================================================== the whole shape

test('the emitted input carries exactly what the reviewer may see', () => {
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+added' },
    { filename: 'pnpm-lock.yaml', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(Object.keys(r.result).sort(), ['excluded', 'files', 'headSha', 'unreviewable']);
  assert.equal(r.result.headSha, SHA);
  assert.equal(r.result.files[0].path, 'src/a.ts');
  assert.deepEqual(r.result.files[0].addedLineRanges, [[2, 2]]);
  assert.deepEqual(r.result.excluded, ['pnpm-lock.yaml']);
  // The PR title and body are attacker-controlled and carry no review value, so
  // they are not in the shape at all rather than being sanitised later.
  assert.equal(r.result.title, undefined);
  assert.equal(r.result.body, undefined);
});

test('newFileLines pins the kind contract, since the JSDoc now promises one', () => {
  // Nothing exercised `removed` or `hunk`, so a tidy-up of the walker would
  // leave every test green and the documented contract false.
  const patch = [
    'diff --git a/x.md b/x.md',
    '@@ -1,2 +1,2 @@',
    ' ctx',
    '-gone',
    '+added',
  ].join('\n');
  const got = newFileLines(patch);
  assert.deepEqual(got.map((l) => l.kind), ['context', 'hunk', 'context', 'removed', 'added']);

  // Only a leading SPACE is stripped, so a line that never carried a diff
  // marker keeps its first character. This fixture cannot tell that apart from
  // `quotableLines`' rule, which also strips `+` and `-`: no line here begins
  // with `+` or `-` while being classified as context, and that is the only
  // place the two strip rules can disagree.
  assert.equal(got[0].text, 'diff --git a/x.md b/x.md');
  assert.equal(got[1].text, '@@ -1,2 +1,2 @@');
  assert.equal(got[2].text, 'ctx');

  // A removed line carries the NEXT new-file line number, because it occupies no
  // line in the new file at all. Reading it as a position is a trap.
  assert.equal(got[3].line, got[4].line);
  assert.deepEqual(addedLineRanges(patch), [[2, 2]]);
});

/**
 * THE PACK IS ONLY REAL IF A WORKFLOW ASKS FOR ONE.
 *
 * `build-review-input.mjs` builds a context pack only when given `--base`, and it
 * fails soft when the pack cannot be built. The production lane passed neither
 * `--base` nor `--body-file`, so every line of this module was dead in
 * production: written, tested, and measured at 7% -> 20% recall on an eval that
 * did pass the flag, while the lane that actually reviews pull requests carried
 * on reviewing the diff alone. Nothing was red. Nothing could be.
 *
 * A unit test cannot see a missing command-line flag in YAML, so it is asserted
 * here, statically, next to the code whose existence depends on it.
 */
test('the PRODUCTION lane asks build-review-input for a context pack', () => {
  const yml = readFileSync(join(HERE, '..', '..', '.github/workflows/claude-review.yml'), 'utf8');
  // SCANNED FOR AN INVOCATION, not anchored on the first mention. This worked
  // only because the comment above the call happens to write the name without
  // `.mjs`; adding the extension there would have made the test measure prose and
  // go on passing. run-judge.test.mjs documents falling into the same trap twice,
  // from both ends of the file.
  const windows = [];
  for (let i = yml.indexOf('build-review-input.mjs'); i !== -1; i = yml.indexOf('build-review-input.mjs', i + 1)) {
    windows.push(yml.slice(i, i + 700));
  }
  assert.ok(windows.length > 0, 'the lane must invoke build-review-input');
  const calls = windows.filter((w) => w.includes('--out '));
  assert.ok(calls.length > 0, 'no window looks like an invocation (none carries --out)');
  for (const call of calls) {
    assert.match(call, /--base /, 'without --base the lane builds no pack at all');
    assert.match(call, /--body-file /, 'without --body-file the PR description never reaches the reviewer');
  }
});

test('the lane checks out FULL HISTORY, or the context pack is silently empty', () => {
  // actions/checkout defaults to fetch-depth: 1, and on a pull_request event that
  // fetches only refs/pull/N/merge -- so neither base.sha nor head.sha is in the
  // object database. `git grep <base.sha>` and `git show <head.sha>:path` then
  // exit 128 ("unable to parse object", reproduced in a real depth-1 clone), both
  // callers catch and return nothing, and the pack holds zero siblings and zero
  // file evidence while logging "0 sibling excerpt(s), 0 file(s)" -- exactly what
  // a PR with genuinely no siblings logs.
  //
  // This was the THIRD way this feature was inert in production: the judge with
  // no spawn, the lane with no --base, and a checkout with no history. Each
  // failed soft; each looked healthy. Asserted statically because no unit test
  // can see a missing YAML key, which is how all three survived.
  // DERIVED, not hand-listed. The rule is "any workflow that invokes these
  // scripts needs full history"; a hardcoded pair means a lane added later
  // inherits the rule and not the assertion, and its failure is silent by
  // construction -- which is the property that made this the THIRD way the
  // feature was inert in production.
  const dir = join(HERE, '..', '..', '.github/workflows');
  const wfs = readdirSync(dir).filter((f) => {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) return false;
    const text = readFileSync(join(dir, f), 'utf8');
    // build-review-input only. The eval also builds packs, but its cases name
    // squash-merged head shas that no clone depth can reach (measured: 0 of 18
    // are ancestors of origin/main), so full history would be a remedy for
    // nothing there -- and asserting it would pin a workflow to a setting that
    // does not help it.
    return text.includes('build-review-input.mjs');
  });
  assert.ok(wfs.length > 0, 'no workflow invokes these scripts -- this test would pass vacuously');
  for (const wf of wfs) {
    const yml = readFileSync(join(dir, wf), 'utf8');
    // BOUNDED BY THE STEP, not by a character count. A 700-char window passed
    // until the explanatory comment above `fetch-depth: 0` grew past it, at which
    // point this guard went blind on the very file it exists for.
    // EVERY checkout, not the first. A workflow can hold two jobs; if the first
    // job's checkout is full-history and the job that actually invokes this
    // script keeps the shallow default, keying on the first occurrence passes
    // exactly where retrieval fails. `- run:` bounds a step too -- without it a
    // later run step's text sits inside the window and can satisfy the match on
    // the checkout's behalf.
    let i = yml.indexOf('actions/checkout');
    assert.notEqual(i, -1, `${wf} must check out the repository`);
    while (i !== -1) {
      const rest = yml.slice(i);
      // ANY step-shaped key, not an enumeration. `- if:`-first steps exist, and
      // a missed spelling re-opens the window this bound exists to close.
      const end = rest.search(/\n\s*- [a-zA-Z_-]+:/);
      assert.match(
        end === -1 ? rest : rest.slice(0, end),
        /fetch-depth: 0/,
        `${wf}: without fetch-depth: 0 the context pack is empty on every run, and says nothing about it`,
      );
      i = yml.indexOf('actions/checkout', i + 1);
    }
  }
});
