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
import { addedLineRanges, newFileLines, buildInput, isExcluded, MAX_PATCH_BYTES, OMITTED_FOR_PROMPT_REASON, fitFilesToPrompt } from './build-review-input.mjs';
import { buildPack, MAX_PROMPT_BYTES } from './build-context-pack.mjs';
import { buildPrompt } from './run-reviewer.mjs';
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

test('#3634: diff-header prefixes inside a hunk are content, not headers', () => {
  const removedRule = ['--- a/doc.md', '+++ b/doc.md', '@@ -1,3 +1,3 @@', ' # Title', '----', '+replacement', ' tail'].join('\n');
  assert.deepEqual(addedLineRanges(removedRule), [[2, 2]]);

  const addedIncrement = ['--- a/code.ts', '+++ b/code.ts', '@@ -1,1 +1,2 @@', ' context', '+++i;'].join('\n');
  assert.deepEqual(addedLineRanges(addedIncrement), [[2, 2]]);
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

test('binary extensions GitHub sends no patch for are excluded, not left to fall through as unread', () => {
  for (const p of ['apps/viewer/public/favicon.ico', 'data/warehouse/export.parquet', 'fixtures-out/topic.bcf', 'apps/viewer/public/fonts/Inter.woff', 'docs/demo.gif', 'apps/viewer/public/hero.webp']) {
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
  assert.deepEqual(r.result.unreviewable[0], {
    path: 'src/huge.ts',
    reason: 'no patch returned (too large)',
    // UNREAD, not no-content: GitHub had content here and declined to send it,
    // so this row must reach the marker's `omitted=` count (#3688).
    kind: 'unread',
  });
  assert.match(r.out, /NOT shown to the reviewer/);
});

test('a PURE rename (changes: 0) is no-content, never counted as omitted', () => {
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    { filename: 'src/moved.ts', status: 'renamed', changes: 0 },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.result.unreviewable[0], {
    path: 'src/moved.ts',
    reason: 'a pure rename: no content changed',
    kind: 'no-content',
  });
  // Nothing was withheld, so the PARTIAL REVIEW warning must not fire over it
  // (the row still appears in the unconditional "not shown" listing below,
  // same as a deletion would -- that listing is not the omission disclosure).
  assert.doesNotMatch(r.out, /::warning::.*PARTIAL REVIEW/);
});

test('a RENAME-PLUS-EDIT (changes > 0, no patch) is UNREAD, not a pure rename', () => {
  // `status === 'renamed'` used to be the whole test for "no content changed",
  // which misclassified this row: GitHub set `status: 'renamed'` because the
  // path moved, but the file also has real content the reviewer never saw
  // (GitHub declined the patch the same way it would for a too-large modified
  // file). Read as a pure rename, this row silently never reached `omitted=`.
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    { filename: 'src/moved-and-edited.ts', status: 'renamed', changes: 4000 },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.result.unreviewable[0], {
    path: 'src/moved-and-edited.ts',
    reason: 'no patch returned (too large)',
    kind: 'unread',
  });
  assert.match(r.out, /::warning::.*PARTIAL REVIEW/);
});

test('a BINARY file (changes: 0, no patch, not renamed) is no-content, not falsely UNREAD', () => {
  // Every non-renamed no-patch row used to be classified `unread` -- "too
  // large" -- but GitHub also omits `patch` for binary content whose extension
  // is not on the exclusion list. A small binary produced a false PARTIAL
  // warning and cleared `llm-reviewed`, even though nothing was ever withheld:
  // there was no text to show.
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    { filename: 'assets/logo.avif', status: 'modified', changes: 0 },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.result.unreviewable[0], {
    path: 'assets/logo.avif',
    reason: 'binary or no textual change',
    kind: 'no-content',
  });
  assert.doesNotMatch(r.out, /::warning::.*PARTIAL REVIEW/);
});

test('a deleted file is unreviewable, not a phantom clean file', () => {
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-a\n-b' },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.result.unreviewable[0], { path: 'src/gone.ts', reason: 'deleted', kind: 'no-content' });
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
  // A percentage claim ("~60% of the diff could be read") only holds for
  // evenly sized files; it is not true in general and was never measured for
  // this cap. The message now states what IS guaranteed instead: below the
  // cap the largest-first fit keeps whatever fits, and the omitted list names
  // the rest.
  assert.doesNotMatch(r.out, /%/, 'no percentage claim');
  assert.match(r.out, /largest-first fit keeps/);
  assert.match(r.out, /omitted list/);
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

// =========================================== degrade to fit the model prompt (#3679)

/**
 * A file row whose patch is EXACTLY `bytes` bytes. The 20-byte prefix is one
 * hunk header, one context line and the `+` marker, so the padding is a single
 * added line -- the shape a large generated-ish source diff actually has.
 */
const sizedRow = (name, bytes) => ({
  filename: name,
  status: 'modified',
  patch: `@@ -1,1 +1,2 @@\n a\n+${'x'.repeat(bytes - 20)}`,
});

test('MEASURED (#3679): a diff AT the patch cap becomes a REAL prompt under MAX_PROMPT_BYTES', () => {
  // The defect, measured on PR #3668: MAX_PATCH_BYTES (600 KB) is bigger than
  // the prompt the model accepts (a 421,355-byte prompt passed; 580,241 failed
  // MODEL_ERROR), and run-reviewer has no path from MODEL_ERROR to a marker --
  // an unclearable red. So this drives the REAL pipeline exactly as main() and
  // the workflow do -- buildInput, then buildPack, then buildPrompt with the
  // shipped rubric -- at the largest diff the lane accepts, and measures the
  // artefact. The arithmetic version of this claim has been true by
  // construction twice in this file's history; only the assembled prompt
  // counts.
  const rubric = readFileSync(join(HERE, 'rubric.md'), 'utf8');
  // MIXED granularity, and the small files are the load-bearing half: with only
  // 15 KB files the greedy fill stops ~6 KB short of whichever budget it is
  // given, so a mutation that stops charging the per-row envelope (a ~28 KB
  // error at this row count) still keeps the same file set and this test stays
  // green -- measured, that exact mutation survived the coarse fixture. 1 KB
  // files make the fill track the budget to within a kilobyte, so a budget
  // inflated by an uncharged envelope overfills the prompt and the byte
  // assertion below goes red.
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => sizedRow(`packages/some/nested/module/file-${i}.ts`, 15 * 1024)),
    ...Array.from({ length: 150 }, (_, i) => sizedRow(`packages/some/nested/module/small-${i}.ts`, 1_024)),
  ];
  const total = rows.reduce((n, r) => n + Buffer.byteLength(r.patch, 'utf8'), 0);
  assert.equal(total, MAX_PATCH_BYTES, 'fixture precondition: exactly the acceptance bound');

  const input = buildInput(rows, SHA);
  const patchBytes = input.files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0);
  input.contextPack = buildPack(input, {
    baseRef: 'HEAD',
    body: 'B'.repeat(20_000),
    patchBytes,
    exec: (_c, a) => (a[0] === 'show' ? 'y'.repeat(4_000) : ''),
  });
  const rendered = buildPrompt(rubric, input);
  const bytes = Buffer.byteLength(rendered, 'utf8');
  assert.ok(
    bytes <= MAX_PROMPT_BYTES,
    `the assembled prompt is ${bytes} bytes, over the ${MAX_PROMPT_BYTES} ceiling by ${bytes - MAX_PROMPT_BYTES}`,
  );

  // AND THE ABSENCE IS VISIBLE. A 600 KB diff cannot fully fit a 390 KB prompt,
  // so files MUST have been dropped, every drop must be recorded under the
  // constant reason, and the prompt itself must tell the model not to vouch for
  // them. A degrade that fit by silently discarding would pass the byte
  // assertion above and be the worse defect.
  const omitted = input.unreviewable.filter((u) => u.reason === OMITTED_FOR_PROMPT_REASON);
  assert.ok(omitted.length > 0, 'a diff at the cap cannot fully fit; something must be recorded as omitted');
  assert.equal(input.files.length + omitted.length, rows.length, 'kept + omitted must account for every candidate');
  const sent = new Set(input.files.map((f) => f.path));
  for (const o of omitted) {
    assert.ok(!sent.has(o.path), `${o.path} is both sent and omitted`);
    assert.ok(rendered.includes(JSON.stringify(o.path)), `the prompt must name ${o.path} as NOT shown`);
  }
});

test('MEASURED: LONG paths (188 bytes), spent twice per kept file, still fit MAX_PROMPT_BYTES', () => {
  // The long-path case the 40-byte fixture above cannot see. `buildPrompt`
  // spends a KEPT file's path TWICE -- once in its `--- FILE:` header and once
  // in the `files_reviewed` roster -- so a kept row's true envelope cost grows
  // at ~2 bytes per path byte, while a charge modelled on the unreviewable row
  // grows at ~1. Any such charge is conservative only below the path length
  // where the two lines cross; this repository has 1,070 tracked paths longer
  // than 63 bytes, up to 188. Same real pipeline as above, at the same
  // acceptance bound, with every path at the repository's maximum.
  const rubric = readFileSync(join(HERE, 'rubric.md'), 'utf8');
  const longPath = (i) => `packages/${'d'.repeat(170)}/f-${String(i).padStart(3, '0')}.ts`;
  assert.equal(Buffer.byteLength(longPath(0), 'utf8'), 188, 'fixture precondition: paths at the repo maximum');
  const rows = Array.from({ length: 600 }, (_, i) => sizedRow(longPath(i), 1_024));
  const total = rows.reduce((n, r) => n + Buffer.byteLength(r.patch, 'utf8'), 0);
  assert.equal(total, MAX_PATCH_BYTES, 'fixture precondition: exactly the acceptance bound');

  const input = buildInput(rows, SHA);
  const patchBytes = input.files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0);
  input.contextPack = buildPack(input, {
    baseRef: 'HEAD',
    body: 'B'.repeat(20_000),
    patchBytes,
    exec: (_c, a) => (a[0] === 'show' ? 'y'.repeat(4_000) : ''),
  });
  const rendered = buildPrompt(rubric, input);
  const bytes = Buffer.byteLength(rendered, 'utf8');
  assert.ok(
    bytes <= MAX_PROMPT_BYTES,
    `the assembled prompt is ${bytes} bytes, over the ${MAX_PROMPT_BYTES} ceiling by ${bytes - MAX_PROMPT_BYTES}`,
  );

  // The degrade must still account for every candidate, exactly as above.
  const omitted = input.unreviewable.filter((u) => u.reason === OMITTED_FOR_PROMPT_REASON);
  assert.ok(omitted.length > 0, 'a diff at the cap cannot fully fit; something must be recorded as omitted');
  assert.equal(input.files.length + omitted.length, rows.length, 'kept + omitted must account for every candidate');
});

test('a NORMAL diff is untouched by the fit: every file reviewed, nothing omitted', () => {
  // The other direction, so an over-eager budget cannot ship: 200 KB across 20
  // files is the fat end of this repository's ordinary PRs and must keep the
  // exact behaviour the lane had before #3679.
  const rows = Array.from({ length: 20 }, (_, i) => sizedRow(`packages/a/f${i}.ts`, 10_000));
  const input = buildInput(rows, SHA);
  assert.equal(input.files.length, 20);
  assert.deepEqual(input.unreviewable, []);
});

test('the fit keeps the LARGEST files, deterministically', () => {
  // Largest first because the largest files carry the most changed lines: for a
  // fixed byte budget that ordering maximises how much of the diff is read. The
  // small file is listed FIRST in the row order to prove selection is by size,
  // not by position.
  const input = buildInput(
    [
      sizedRow('packages/a/small.ts', 40_000),
      sizedRow('packages/a/big.ts', 200_000),
      sizedRow('packages/a/mid.ts', 150_000),
    ],
    SHA,
  );
  assert.deepEqual(input.files.map((f) => f.path), ['packages/a/big.ts', 'packages/a/mid.ts']);
  assert.deepEqual(input.unreviewable, [
    { path: 'packages/a/small.ts', reason: OMITTED_FOR_PROMPT_REASON, kind: 'unread' },
  ]);
});

test('one file too big for the budget does not block the files behind it', () => {
  // Greedy, not prefix: a 380 KB file exceeds the whole diff budget on its own.
  // Refusing the PR for it would re-create the unclearable red for the two
  // ten-KB files that review fine.
  const input = buildInput(
    [
      sizedRow('packages/a/giant.ts', 380_000),
      sizedRow('packages/a/one.ts', 10_000),
      sizedRow('packages/a/two.ts', 10_000),
    ],
    SHA,
  );
  assert.deepEqual(input.files.map((f) => f.path), ['packages/a/one.ts', 'packages/a/two.ts']);
  assert.deepEqual(input.unreviewable, [
    { path: 'packages/a/giant.ts', reason: OMITTED_FOR_PROMPT_REASON, kind: 'unread' },
  ]);
});

test('NOTHING fits: a single oversized file is a SKIP with a marker, never an empty review', () => {
  // files=[] here must NOT fall through to NO_FILES, whose marker body asserts
  // the exclusion-list cause -- that sentence over 380 KB of real source would
  // be a lying marker. NOTHING_FITS is its own reason code and carries its own
  // sentence to the comment, which is what made the marker route honest.
  //
  // It is a SKIP rather than a red because no re-run can clear it: the cause is
  // a property of the PR. Failing left the review-posted gate printing "REMEDY:
  // re-run the review job" against a red only splitting the PR could remove.
  const r = run([sizedRow('packages/a/giant.ts', 380_000)]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOTHING_FITS/);
  assert.match(r.out, /No single file/);
  assert.match(r.out, /nothing-to-review/, 'the message must name the route, not just refuse');
  assert.match(r.out, /split the PR/);
});

test('REGRESSION (#3688): a 500 KB single file is refused, and says so as a SKIP not a red', () => {
  // The bound this branch silently moved. `MAX_PATCH_BYTES` is 600 KB and the
  // module docblock said a sub-cap diff is "DEGRADED, never refused"; the
  // up-front charge dropped the real single-file bound to ~357 KB, so 360/400/
  // 500/590 KB single-file PRs all went from reviewed to an unclearable red.
  //
  // 500 KB genuinely cannot be reviewed -- MAX_PROMPT_BYTES is 390,000, so no
  // budget arithmetic makes it fit, and that half of the claim was simply
  // false. What it CAN have is an honest posted marker instead of a red, and
  // the message must name the real number rather than a fixed sentence.
  const r = run([sizedRow('packages/a/huge.ts', 500 * 1024)]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOTHING_FITS/);
  assert.match(r.out, /the smallest of the 1 is 512000 bytes/, 'the message must state the measurement');
});

test('REGRESSION (#3688): 1,000 tiny files with long paths BUILD, and keep every one', () => {
  // 29 bytes of patch each, 29 KB in total against a 390,000-byte prompt --
  // nothing here is close to any limit. The up-front `max(kept, omitted)` charge
  // billed every candidate for a role it does not end up in, so the row
  // overhead alone drove the budget down and files were dropped (and at 2,000
  // the whole PR was refused). A file pays for the role it lands in.
  const long = 'packages/some-really-quite-long-package-name/src/features/deeply/nested/area';
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    filename: `${long}/module-${i}/component-implementation-${i}.tsx`,
    status: 'modified',
    patch: '@@ -1,1 +1,1 @@\n+abcdefghijkl',
  }));
  const total = rows.reduce((n, r) => n + Buffer.byteLength(r.patch, 'utf8'), 0);
  assert.ok(total < 30_000, `the fixture must be trivially small; it is ${total} bytes`);
  const r = run(rows);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.result.files.length, 1000, 'every file fits, so every file must be kept');
  assert.equal(r.result.unreviewable.length, 0);
});

test('REGRESSION (#3688): when the PATHS are what does not fit, the message says so', () => {
  // The old message was "No single file's patch fits the model prompt", printed
  // for 2,000 files whose patches are 13 bytes each. It was false about all
  // 2,000, and it sent the reader looking for a large file that is not there.
  const long = 'packages/some-really-quite-long-package-name/src/features/deeply/nested/area';
  const rows = Array.from({ length: 3000 }, (_, i) => ({
    filename: `${long}/module-${i}/component-implementation-${i}.tsx`,
    status: 'modified',
    patch: '@@ -1,1 +1,1 @@\n+x',
  }));
  const r = run(rows);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOTHING_FITS/);
  assert.match(r.out, /It is the FILE COUNT, not the diff/);
  assert.doesNotMatch(r.out, /No single file/, 'the other cause must not be claimed here');
});

test('the PROCESS says PARTIAL loudly and keeps the emitted shape stable', () => {
  const rows = Array.from({ length: 40 }, (_, i) => sizedRow(`packages/some/nested/module/file-${i}.ts`, 15 * 1024));
  const r = run(rows);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning::.*PARTIAL REVIEW/, 'a silent degrade is the absence-reads-as-success shape');
  assert.match(r.out, /NOT shown to the reviewer/);
  // Same top-level shape as a full review: downstream readers (validate-findings
  // readInput, the eval) must not need a second schema for the degraded case.
  assert.deepEqual(Object.keys(r.result).sort(), ['excluded', 'files', 'headSha', 'unreviewable']);
});

test('the PARTIAL REVIEW log and the marker omitted-count agree on a GitHub-too-large row', () => {
  // The log used to match `reason === OMITTED_FOR_PROMPT_REASON` while the
  // marker (via `omittedForPromptPaths`) matched `kind === UNREVIEWABLE_UNREAD`
  // -- two independently spelled predicates over the same rows. A file GitHub
  // itself refused a patch for (never touched by `fitFilesToPrompt`, so its
  // reason is 'no patch returned (too large)', not OMITTED_FOR_PROMPT_REASON)
  // used to be silent in this log while still reaching the marker's
  // `omitted=` count downstream -- log and marker disagreeing about the same
  // run. Both now read `isUnread`, so this row is disclosed in both places.
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    { filename: 'src/huge.ts', status: 'modified', changes: 99999 },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.result.unreviewable[0].reason, 'no patch returned (too large)');
  assert.equal(r.result.unreviewable[0].kind, 'unread');
  assert.match(r.out, /::warning::.*PARTIAL REVIEW -- 1 file/, 'the log must count this row too');
});

test('an omitted path with QUOTES or BACKSLASHES is charged as RENDERED', () => {
  // Through the shipped `fitFilesToPrompt`, differentially. The first version of
  // this test reimplemented the charge formula locally and asserted on its own
  // copy, so reverting the source to raw bytes failed nothing -- two copies held
  // together by prose, in the test guarding the arithmetic.
  //
  // `buildPrompt` emits the path JSON-escaped, so a quote costs three bytes where
  // the raw string costs one and a backslash two. Same size files, same count,
  // only the path shape differs: charging the escaped form must keep FEWER.
  const mk = (name, n, per) =>
    Array.from({ length: n }, (_, i) => ({
      path: name(i),
      patch: `@@ -1,1 +1,2 @@\n+${'x'.repeat(per)}\n`,
    }));
  // IDENTICAL RAW LENGTH, different escaped length -- 30 bytes each, 32 vs 48
  // once JSON-escaped. The first attempt used paths that were longer raw too, so
  // it discriminated on length and passed with the escaping ignored.
  const plain = (i) => `vendor/aaaaaaaaaaaaaaaa${String(i).padStart(4, '0')}.ts`;
  const nasty = (i) => `vendor/""""""""""""""""${String(i).padStart(4, '0')}.ts`;
  assert.equal(
    Buffer.byteLength(plain(1), 'utf8'),
    Buffer.byteLength(nasty(1), 'utf8'),
    'fixture: same raw size, or this measures length rather than escaping',
  );

  const a = fitFilesToPrompt(mk(plain, 900, 380), []);
  const b = fitFilesToPrompt(mk(nasty, 900, 380), []);
  assert.ok(
    b.kept.length < a.kept.length,
    `escape-heavy paths kept ${b.kept.length} against ${a.kept.length} for plain ones: the charge is ` +
      'counting raw bytes, so the budget is being spent on characters the prompt renders larger',
  );
});

// ============ THE ARMS OF `max(keptCharge, omittedCharge)`, EACH PINNED
//
// Both arms are load-bearing and NEITHER was reachable by an existing test:
// deleting either left the whole suite green while the real pipeline blew
// through MAX_PROMPT_BYTES. The long-path test above pressures only the KEPT
// arm, because a long path makes kept the larger of the two and its fixture
// carries no pre-existing unreviewable rows.
//
// The crossover sits near a 56-byte path: BELOW it an omitted row costs MORE
// than a kept one, because the omitted row carries a fixed ~69-byte reason
// while a kept row is mostly the path itself. So SHORT paths exercise the
// omitted arm -- the opposite of the intuition behind the existing fixtures.
//
// Both fixtures below are tuned so the CORRECT charge leaves real headroom and
// the wrong one overruns. That tuning is the whole difficulty: a first attempt
// used patches at MAX_PATCH_BYTES (614,400), where every patch exceeds the
// entire prompt budget, so kept === 0 under both correct and mutated charging
// and the assembled prompt was byte-identical. It could not fail. Patches must
// be small enough that the freed budget is actually SPENT on kept files.

test('the OMITTED arm holds when short paths make omission the dearer role', () => {
  // Mutation-measured: correct 376,363 bytes (13,637 under the ceiling);
  // charging the kept rate only admits 129 files instead of 48 and assembles
  // 533,990 -- 143,990 OVER.
  const candidates = Array.from({ length: 3000 }, (_, i) => ({
    path: `s/${String(i).padStart(4, '0')}.ts`,
    patch: 'x'.repeat(2000),
  }));
  const { kept, omitted } = fitFilesToPrompt(candidates, []);
  assert.ok(kept.length > 0, 'the fixture must keep something, or the budget is never spent');
  assert.ok(omitted.length > 0, 'the fixture must actually force omissions');

  const bytes = Buffer.byteLength(buildPrompt(readFileSync(join(HERE, 'rubric.md'), 'utf8'), {
    headSha: 'a'.repeat(40),
    files: kept,
    unreviewable: omitted.map((c) => ({ path: c.path, reason: OMITTED_FOR_PROMPT_REASON })),
  }), 'utf8');
  assert.ok(
    bytes <= MAX_PROMPT_BYTES,
    `short-path mass omission assembled ${bytes} bytes, over the ${MAX_PROMPT_BYTES} ceiling by ${bytes - MAX_PROMPT_BYTES}`,
  );
});

test('PRE-EXISTING unreviewable rows are charged before the candidates are', () => {
  // The other unpinned arm: the `for (const u of unreviewable)` debit. Deleted
  // files arrive as unreviewable rather than as candidates, so nothing else
  // charges them. Mutation-measured: correct keeps 102 files for 374,740 bytes
  // (15,260 under); removing the debit keeps 172 and assembles 511,804 --
  // 121,804 OVER.
  const unreviewable = Array.from({ length: 800 }, (_, i) => ({
    path: `packages/deep/nested/mod/deleted-${i}-${'x'.repeat(100)}.ts`,
    reason: 'file deleted in this diff',
  }));
  const candidates = Array.from({ length: 200 }, (_, i) => ({
    path: `packages/p/keep-${i}.ts`,
    patch: 'y'.repeat(2000),
  }));
  const { kept, omitted } = fitFilesToPrompt(candidates, unreviewable);
  assert.ok(kept.length > 0, 'the fixture must keep something, or the budget is never spent');
  // The decay guard its sibling already had, and this one did not. Demonstrated:
  // with MAX_PROMPT_BYTES raised back to its historical 700,000 AND the debit
  // deleted, every candidate is kept, `omitted` is empty, there is no pressure
  // left and the mutation goes undetected while the test stays green. Today six
  // other tests fail loudly on a ceiling change so it is not silent yet -- but
  // once those are retuned this becomes a green no-op.
  assert.ok(omitted.length > 0, 'the fixture must force omissions, or there is no pressure to measure');

  const bytes = Buffer.byteLength(buildPrompt(readFileSync(join(HERE, 'rubric.md'), 'utf8'), {
    headSha: 'a'.repeat(40),
    files: kept,
    unreviewable: [
      ...unreviewable,
      ...omitted.map((c) => ({ path: c.path, reason: OMITTED_FOR_PROMPT_REASON })),
    ],
  }), 'utf8');
  assert.ok(
    bytes <= MAX_PROMPT_BYTES,
    `pre-existing unreviewable rows assembled ${bytes} bytes, over the ${MAX_PROMPT_BYTES} ceiling by ${bytes - MAX_PROMPT_BYTES}`,
  );
});
