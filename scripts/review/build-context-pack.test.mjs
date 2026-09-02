/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The property under test: THE PACK MUST SURFACE THE SITE THE PR DID NOT TOUCH.
 *
 * Five of one day's twelve merge-blocking defects were "fixed at one site when
 * the codebase has two", and in every case the unfixed site was the published
 * one. A baseline eval of the current lane scored 1/15 and missed all five.
 * Running the CodeRabbit CLI over three of them found the sibling in none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt } from './run-reviewer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
import { searchKeys, hunkLines, fileEvidence, MAX_WHOLE_FILE_LINES, buildPack, truncateUtf8, BODY_RESERVE_BYTES, MAX_PACK_BYTES, MAX_SEARCH_KEYS, packBudgetFor, MAX_PROMPT_BYTES, retrievalFailed, retrievalFailedMessage, SHALLOW_CHECKOUT_REMEDY, PROMPT_BASE_OVERHEAD_BYTES, promptEnvelopeBytes } from './build-context-pack.mjs';

test('search keys come from REMOVED lines first, because the sibling still has them', () => {
  const patch = [
    '@@ -1,3 +1,3 @@',
    ' ctx',
    '-  const legacyHelperName = raw;',
    '+  const legacyHelperName = srgbToLinear(raw);',
  ].join('\n');
  const keys = searchKeys(patch, { path: 'a.ts' });
  assert.ok(keys.includes('legacyHelperName'));
  assert.ok(keys.indexOf('legacyHelperName') < keys.indexOf('srgbToLinear'),
    'what the PR deleted at site A is what site B still contains, so it ranks first');
});

test('PROSE MUST NOT EAT THE KEY BUDGET', () => {
  // Measured on two real cases: every extracted key came from the MPL licence
  // header ("Source, subject, terms, Mozilla, Public, License") or changeset
  // markdown, and the identifiers that actually find the sibling never got a
  // slot. Filtering prose took second-site retrieval from 0/5 to 4/5.
  const licence = [
    '@@ -1,4 +1,5 @@',
    '+/* This Source Code Form is subject to the terms of the Mozilla Public',
    '+ * License, v. 2.0. If a copy of the MPL was not distributed with this',
    '+ * file, You can obtain one at https://mozilla.org/MPL/2.0/. */',
    '+const missingLanes = computeLanes(rollup);',
  ].join('\n');
  const keys = searchKeys(licence, { path: 'a.mjs' });
  assert.ok(keys.includes('missingLanes'), 'the identifier must survive the header');
  for (const junk of ['Mozilla', 'License', 'subject', 'distributed']) {
    assert.ok(!keys.includes(junk), `${junk} is prose, not a second implementation`);
  }
});

test('markdown yields no keys at all: a changeset is not an implementation', () => {
  const md = ['@@ -1,2 +1,3 @@', "+Both tools now share a materialDisplayName helper."].join('\n');
  assert.deepEqual(searchKeys(md, { path: '.changeset/x.md' }), []);
});

test('a long file is windowed around its hunks, not truncated from the top', () => {
  // A defect in count-distortion or dedup lives in the FUNCTION, not the hunk.
  // Truncating from line 1 would reliably cut the part that matters.
  const patch = ['@@ -900,2 +900,3 @@', ' ctx', '+added'].join('\n');
  const big = Array.from({ length: MAX_WHOLE_FILE_LINES + 500 }, (_, i) => `line${i}`).join('\n');
  const e = fileEvidence(patch, big);
  assert.equal(e.kind, 'window');
  assert.ok(e.from < 900 && e.to > 900, 'the window must contain the hunk');
});

test('hunkLines numbers the NEW file, so a window lands where the reader will look', () => {
  assert.deepEqual(hunkLines('@@ -1,2 +10,4 @@\n ctx\n+one\n+two'), [11, 12]);
});

/**
 * A pack under REAL budget pressure, which is the only condition the reservation
 * has any effect under. The first version of these tests supplied `exec: () => ''`
 * -- no siblings, no file content, nothing competing -- so the body got its bytes
 * whether or not anything was reserved for it, and BOTH mutations passed. A
 * fixture that cannot exhaust the budget cannot test a budget.
 *
 * `exec` answers `git show` with a large file so the evidence stage spends
 * heavily, exactly as the real pr-3389 pack did.
 */
function packUnderPressure(body) {
  // MANY SMALL FILES, not a few huge ones. The evidence loop `continue`s past a
  // file that does not fit and tries the next, so a handful of oversized files
  // leaves tens of kilobytes unspent -- enough that the body got its 8,000 bytes
  // with or without a reservation, and the mutation passed. Small files pack the
  // budget tight, which is the state the reservation exists for.
  const smallFile = Array.from({ length: 60 }, (_, i) => `const line${i} = ${i}; // padding`).join('\n');
  const files = Array.from({ length: 400 }, (_, i) => ({
    path: `packages/a/f${i}.ts`,
    patch: `@@ -1,1 +1,2 @@\n+const changed${i} = 1;\n+const other${i} = 2;`,
  }));
  return buildPack(
    { headSha: 'a'.repeat(40), files },
    { baseRef: 'HEAD', body, exec: (_cmd, args) => (args[0] === 'show' ? smallFile : '') },
  );
}

test('the fixture actually exhausts the budget, or the tests below prove nothing', () => {
  // THE META-CHECK. If this stops holding, the reservation tests silently stop
  // testing the reservation -- which is exactly what happened when they were
  // first written, and both mutations passed.
  const pack = packUnderPressure(null);
  assert.ok(
    // @source-text-assertion-ok asserts on the pack's own truncation list, a runtime value, not on any file's text
    pack.truncated.some((t) => t.startsWith('full content of')),
    `nothing was truncated, so there is no budget pressure: ${JSON.stringify(pack.truncated)}`,
  );
  // Sharper: with NO body reserved, the bytes left over must be less than the
  // reserve. Otherwise a reservation changes nothing and its test cannot fail.
  const spent =
    pack.siblings.reduce((n, h) => n + Buffer.byteLength(h.text, 'utf8') + 120, 0) +
    pack.fileEvidence.reduce((n, e) => n + Buffer.byteLength(e.text, 'utf8') + 80, 0);
  assert.ok(
    MAX_PACK_BYTES - spent < BODY_RESERVE_BYTES,
    `${MAX_PACK_BYTES - spent} bytes left unspent, more than the ${BODY_RESERVE_BYTES} reserve: ` +
      'a body would fit without reserving anything, so the reservation test is vacuous',
  );
});

test('THE PR BODY IS RESERVED BEFORE THE GREEDY SPENDERS RUN', () => {
  // Siblings and file evidence are allocated first. On a large PR they exhausted
  // the pack and the description, allocated last, got the scraps: measured on
  // pr-3389 -- whose expected defect IS a contradiction between the description
  // and the diff -- 964 bytes of a 12,427-byte body survived, and the sentence
  // the defect turns on was not among them. Wiring the body through without a
  // reservation would have fixed the plumbing and left the case unscoreable.
  const body = 'B'.repeat(20_000);
  const pack = packUnderPressure(body);
  const kept = Buffer.byteLength(pack.body ?? '', 'utf8');
  assert.ok(kept >= BODY_RESERVE_BYTES, `the body kept ${kept} bytes, under its ${BODY_RESERVE_BYTES} reserve`);

  const textBytes =
    pack.siblings.reduce((n, h) => n + Buffer.byteLength(h.text, 'utf8'), 0) +
    pack.fileEvidence.reduce((n, e) => n + Buffer.byteLength(e.text, 'utf8'), 0) +
    kept;
  assert.ok(textBytes <= MAX_PACK_BYTES, `pack text is ${textBytes}, over the ${MAX_PACK_BYTES} cap`);
});

test('THE CALL SITE truncates the body by BYTES, not by UTF-16 code units', () => {
  // Aimed at the call site, not at `truncateUtf8`. Testing the helper alone left
  // the call site free to go back to `slice` -- the mutation passed, because the
  // helper it exercised was never the thing that changed.
  const pack = packUnderPressure('😀'.repeat(20_000));
  const kept = Buffer.byteLength(pack.body ?? '', 'utf8');
  assert.ok(kept <= MAX_PACK_BYTES, `the body alone is ${kept} bytes, over the whole pack cap`);
  // @source-text-assertion-ok asserts the pack body has no replacement char -- a property of the assembled output
  assert.ok(!(pack.body ?? '').includes('\uFFFD'), 'a multi-byte character was split');
  const textBytes =
    pack.siblings.reduce((n, h) => n + Buffer.byteLength(h.text, 'utf8'), 0) +
    pack.fileEvidence.reduce((n, e) => n + Buffer.byteLength(e.text, 'utf8'), 0) +
    kept;
  assert.ok(textBytes <= MAX_PACK_BYTES, `pack text is ${textBytes}, over the ${MAX_PACK_BYTES} cap`);
});

test('no body means no reservation, so siblings and evidence get the whole pack', () => {
  // The other direction: the reserve must not be withheld from a PR with no
  // description, which would shrink every pack to pay for an absent section.
  const withNone = packUnderPressure(null);
  assert.equal(withNone.body, null);
  assert.ok(!withNone.truncated.includes('PR description'));
});

test('truncateUtf8 cuts on a character boundary, never mid-sequence', () => {
  const emoji = '😀'.repeat(10);
  for (const limit of [0, 1, 3, 4, 5, 7, 8, 39, 40]) {
    const out = truncateUtf8(emoji, limit);
    assert.ok(Buffer.byteLength(out, 'utf8') <= limit, `${limit}: produced ${Buffer.byteLength(out, 'utf8')} bytes`);
    assert.ok(!out.includes('\uFFFD'), `${limit}: split a character`);
    assert.equal(out, '😀'.repeat(Math.floor(limit / 4)), `${limit}: wrong number of whole characters`);
  }
});

test('a sibling site keeps its HIGHEST-RANKED key, not the first key that found it', () => {
  // De-duplication used to happen while collecting candidates, so a site was
  // claimed by whichever key reached it first -- and `rank` then scored the site
  // on that key. Iteration is per changed file, so a five-letter token in the
  // first file could claim a site that a 27-character function name in the second
  // file also matched, and score it at +10 instead of +30 (searchKeys drops any
  // token under five characters, so five is the shortest a key can be). On a pack under
  // pressure that is the difference between the sibling appearing and being cut,
  // which is the entire purpose of the retrieval.
  const one = { path: 'packages/a/one.ts', patch: '@@ -1,1 +1,2 @@\n+  const cache = 1;\n' };
  const two = { path: 'packages/b/two.ts', patch: '@@ -1,1 +1,2 @@\n+  resolveHighlightIdentifiers(x);\n' };
  assert.deepEqual(searchKeys(one.patch, { path: one.path, max: 12 }), ['cache'], 'fixture: weak key first');
  assert.deepEqual(
    searchKeys(two.patch, { path: two.path, max: 12 }),
    ['resolveHighlightIdentifiers'],
    'fixture: strong key second',
  );

  // Both keys match the SAME sibling line.
  const site = 'HEAD:packages/z/sibling.ts:42:  const cache = resolveHighlightIdentifiers(y);';
  const pack = buildPack(
    { headSha: 'a'.repeat(40), files: [one, two] },
    { baseRef: 'HEAD', body: null, exec: (_cmd, args) => (args[0] === 'grep' ? site : '') },
  );

  assert.equal(pack.siblings.length, 1, 'one row per site');
  assert.equal(
    pack.siblings[0].key,
    'resolveHighlightIdentifiers',
    'the site must carry the key that scores it highest, not the one that reached it first',
  );
});

test('the body reserve is a CEILING as well as a floor', () => {
  // The other direction, and the one that was missing. The reservation was
  // written as `bodyReserve + budget`, handing the body every byte the greedy
  // stages had not spent: on a small PR with a long description that measured
  // 159,908 bytes of author-written prose in a 160,000-byte pack, with the diff
  // and the siblings rounding to nothing. The old tests asserted only
  // `kept >= BODY_RESERVE_BYTES`, which that passes.
  const input = {
    headSha: 'a'.repeat(40),
    files: [{ path: 'packages/a/f.ts', patch: '@@ -1,1 +1,2 @@\n+const x = 1;\n' }],
  };
  const pack = buildPack(input, { baseRef: 'HEAD', body: 'B'.repeat(300_000), exec: () => '' });
  const kept = Buffer.byteLength(pack.body ?? '', 'utf8');
  assert.ok(
    kept <= BODY_RESERVE_BYTES,
    `the body claimed ${kept} bytes against a ${BODY_RESERVE_BYTES} reserve; untrusted prose must not ` +
      'expand into whatever the rest of the pack left unspent',
  );
  // @source-text-assertion-ok the truncation list is buildPack's output, not source text
  assert.ok(pack.truncated.includes('PR description'));
});


test('one grep PER KEY, because the batched form is dramatically slower', () => {
  // Measured on this repo with the real key set searchKeys produces: 10 keys,
  // 748 ms per-key against 2,026 ms batched; 54 keys, 3,955 ms against 26,020 ms.
  // git's fixed-string matcher degrades superlinearly in pattern count. The batch
  // had been written against a "274 keys, 22.9 seconds" figure measured on a
  // SHALLOW checkout, where every grep exited in milliseconds having found
  // nothing -- it timed the bug, not the work.
  let greps = 0;
  const files = Array.from({ length: 3 }, (_, i) => ({
    path: `packages/a/f${i}.ts`,
    patch: `@@ -1,1 +1,2 @@\n+  const resolveHighlight${i} = compute${i}();\n`,
  }));
  buildPack({ headSha: 'a'.repeat(40), files }, {
    baseRef: 'HEAD',
    body: null,
    exec: (_cmd, args) => {
      if (args[0] === 'grep') {
        greps += 1;
        assert.equal(args.filter((a) => a === '-e').length, 1, 'one pattern per grep');
      }
      return '';
    },
  });
  assert.ok(greps >= 3, `expected one grep per key, saw ${greps}`);
});

test('the global key cap is RECORDED, not silent', () => {
  // A cap that drops keys without saying so is a retrieval that searched half the
  // diff and reported success.
  const files = Array.from({ length: 200 }, (_, i) => ({
    path: `packages/a/f${i}.ts`,
    patch: `@@ -1,1 +1,2 @@\n+  const uniqueIdentifier${i} = compute${i}();\n`,
  }));
  let greps = 0;
  const pack = buildPack({ headSha: 'a'.repeat(40), files }, {
    baseRef: 'HEAD',
    body: null,
    exec: (_cmd, args) => {
      if (args[0] === 'grep') greps += 1;
      return '';
    },
  });
  assert.ok(greps <= MAX_SEARCH_KEYS, `${greps} greps exceeds the ${MAX_SEARCH_KEYS} cap`);
  assert.ok(
    // @source-text-assertion-ok same: the pack's own record of what it dropped
    pack.truncated.some((t) => t.startsWith('sibling search for')),
    `the cap fired but nothing recorded it: ${JSON.stringify(pack.truncated)}`,
  );
});


test('NO PR THAT WAS REVIEWABLE BECOMES UNREVIEWABLE: the pack yields, the diff does not', () => {
  // An earlier attempt charged the pack against the diff budget, cutting the diff
  // allowance from 600 KB to 454,400 bytes. The largest PR observed on this repo
  // is ~427 KB -- 96% of that -- and crossing it throws REVIEW_TOO_LARGE, which
  // claude-review.yml turns into a red job with NO marker that no re-run clears.
  // Fixing a token ceiling by refusing work the lane used to do is not a fix.
  assert.equal(packBudgetFor(0, promptEnvelopeBytes({ files: [{ path: 'a.ts' }] })), MAX_PACK_BYTES, 'a tiny diff gets the whole pack');
  assert.equal(packBudgetFor(100_000, promptEnvelopeBytes({ files: Array.from({ length: 30 }, () => ({ path: 'packages/a/b.ts' })) })), MAX_PACK_BYTES, 'a normal diff still gets the whole pack');
  const maxDiff = 600 * 1024;
  assert.ok(packBudgetFor(maxDiff) >= 0, 'a maximal diff must still be reviewable');
  for (const bytes of [0, 1, 200_000, 427 * 1024, maxDiff, maxDiff * 2, NaN, undefined]) {
    const v = packBudgetFor(bytes, promptEnvelopeBytes({ files: Array.from({ length: 50 }, () => ({ path: 'packages/a/b.ts' })) }));
    assert.ok(Number.isFinite(v) && v >= 0 && v <= MAX_PACK_BYTES, `nonsensical budget at ${bytes}: ${v}`);
  }
});

test('THE REAL PROMPT stays under the ceiling whenever the DIFF alone does', () => {
  // Measured, not derived. The arithmetic version asserted
  // `maxDiff + packBudgetFor(maxDiff) <= MAX_PROMPT_BYTES`, true by construction
  // of packBudgetFor and never touching buildPrompt -- so it could not see that
  // the rubric (~10.6 KB), a header per file, fences and prose were uncounted.
  //
  // Scoped to diffs that fit, deliberately. MAX_PATCH_BYTES (600 KB) is larger
  // than this ceiling, so a maximal diff overruns it whatever the pack does.
  // That is pre-existing -- the lane sent diffs that size long before a pack
  // existed -- and the pack's contract is only that it never makes things worse.
  const rubric = readFileSync(join(HERE, 'rubric.md'), 'utf8');
  // A THOUSAND, not four hundred. At 400 the envelope reserve stops being
  // load-bearing -- the budget re-hits the MAX_PACK_BYTES clamp and the prompt
  // fits whether or not a byte is reserved per file -- so BOTH envelope
  // constants could be zeroed with this suite green. The reserve exists because
  // a 1,000-file diff once shipped a prompt far over the ceiling; the fixture has to
  // reach the size that produced it.
  const fileCount = 1_000;
  const diffTarget = 250_000;
  const per = Math.floor(diffTarget / fileCount);
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `packages/some/deeply/nested/module/file-${i}.ts`,
    patch: `@@ -1,1 +1,2 @@\n+${'x'.repeat(Math.max(1, per - 20))}\n`,
  }));
  const patchBytes = files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0);
  // THE DIFF PLUS ITS ENVELOPE, not the diff alone. `patchBytes < MAX_PROMPT_BYTES`
  // is not the real precondition: at 400 files and 430,000 patch bytes it holds,
  // the pack correctly yields to zero, and the prompt still lands 14,420 over --
  // because the rubric and the per-file headers are not free. The property that
  // is actually true is the one asserted here.
  assert.ok(
    patchBytes + promptEnvelopeBytes({ files }) <= MAX_PROMPT_BYTES,
    'fixture precondition: the diff AND its envelope must fit, or no pack size can save it',
  );
  const input = { headSha: 'a'.repeat(40), files, unreviewable: [] };
  input.contextPack = buildPack(input, {
    baseRef: 'HEAD',
    body: 'B'.repeat(20_000),
    patchBytes,
    exec: (_cmd, args) => (args[0] === 'show' ? 'y'.repeat(4_000) : ''),
  });
  const bytes = Buffer.byteLength(buildPrompt(rubric, input), 'utf8');
  assert.ok(
    bytes <= MAX_PROMPT_BYTES,
    `the assembled prompt is ${bytes} bytes, over the ${MAX_PROMPT_BYTES} ceiling by ${bytes - MAX_PROMPT_BYTES}`,
  );
});

test('THE BASE ENVELOPE RESERVE is load-bearing too, on a FEW-file diff', () => {
  // The 1,000-file case above guards PROMPT_FILE_ROW_FIXED, because the per-file
  // term dominates there -- and it leaves PROMPT_BASE_OVERHEAD_BYTES free to be
  // zeroed with the suite green. The base only bites when there are few headers
  // and the diff is near the ceiling, so that is what this builds: the rubric is
  // ~10.6 KB of the reserve, and it is present on every single review.
  const rubric = readFileSync(join(HERE, 'rubric.md'), 'utf8');
  const fileCount = 10;
  const diffTarget = 350_000;
  const per = Math.floor(diffTarget / fileCount);
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `packages/a/f${i}.ts`,
    patch: `@@ -1,1 +1,2 @@\n+${'x'.repeat(per - 20)}\n`,
  }));
  const patchBytes = files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0);
  assert.ok(patchBytes < MAX_PROMPT_BYTES, 'fixture precondition: the diff itself must fit');
  const input = { headSha: 'a'.repeat(40), files, unreviewable: [] };
  input.contextPack = buildPack(input, {
    baseRef: 'HEAD',
    body: 'B'.repeat(60_000),
    patchBytes,
    exec: (_cmd, args) => (args[0] === 'show' ? 'y'.repeat(4_000) : ''),
  });
  const bytes = Buffer.byteLength(buildPrompt(rubric, input), 'utf8');
  assert.ok(
    bytes <= MAX_PROMPT_BYTES,
    `the assembled prompt is ${bytes} bytes, over the ${MAX_PROMPT_BYTES} ceiling by ${bytes - MAX_PROMPT_BYTES}`,
  );
});

test('when the diff ALONE exceeds the ceiling the pack ADDS NOTHING to the prompt', () => {
  // Measured, because the previous version of this test asserted only
  // `packBudgetFor(...) === 0` while its comment made a claim about the assembled
  // prompt -- re-committing, one test later, exactly the "true by construction of
  // packBudgetFor and never touching buildPrompt" sin the test above it was
  // written to condemn.
  const rubric = readFileSync(join(HERE, 'rubric.md'), 'utf8');
  const files = Array.from({ length: 20 }, (_, i) => ({
    path: `packages/a/f${i}.ts`,
    patch: `@@ -1,1 +1,2 @@\n+${'x'.repeat(30_000)}\n`,
  }));
  const patchBytes = files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0);
  assert.ok(patchBytes > MAX_PROMPT_BYTES, 'fixture precondition: this diff must already be over');
  const input = { headSha: 'a'.repeat(40), files, unreviewable: [] };
  const withPack = { ...input };
  withPack.contextPack = buildPack(input, {
    baseRef: 'HEAD',
    body: 'B'.repeat(60_000),
    patchBytes,
    exec: (_cmd, args) => (args[0] === 'show' ? 'y'.repeat(4_000) : ''),
  });
  const pack = withPack.contextPack;
  assert.equal(pack.siblings.length, 0);
  assert.equal(pack.fileEvidence.length, 0);
  assert.equal(pack.body, null, 'not even the description, once the diff is already over');

  // The prompt is over the ceiling either way -- that is the pre-existing patch
  // cap, filed as #3679 -- but the pack must not be what put it there.
  const bare = Buffer.byteLength(buildPrompt(rubric, input), 'utf8');
  const full = Buffer.byteLength(buildPrompt(rubric, withPack), 'utf8');
  assert.ok(full - bare < 200, `the pack added ${full - bare} bytes to an already-oversized prompt`);
});

test('a near-maximal diff shrinks the pack rather than the review', () => {
  const input = {
    headSha: 'a'.repeat(40),
    files: [{ path: 'packages/a/f.ts', patch: '@@ -1,1 +1,2 @@\n+const x = 1;\n' }],
  };
  // Squeezed hard enough to bite: at 650 KB the remaining pack budget still
  // covers the body's full reserve, so the two runs came out identical and the
  // assertion below could not fail. The diff has to be large enough to cut into
  // the reserve itself.
  const squeeze = MAX_PROMPT_BYTES - 4_000;
  const big = buildPack(input, { baseRef: 'HEAD', body: 'B'.repeat(50_000), patchBytes: squeeze, exec: () => '' });
  const small = buildPack(input, { baseRef: 'HEAD', body: 'B'.repeat(50_000), patchBytes: 0, exec: () => '' });
  assert.ok(
    Buffer.byteLength(big.body ?? '', 'utf8') < Buffer.byteLength(small.body ?? '', 'utf8'),
    'the pack must give way when the diff is large',
  );
});

test('the retrieval-failure DIAGNOSTIC itself works, and names the sha', () => {
  // It did not. A rename left the warning path calling a constant that had been
  // deleted -- a ReferenceError on the one message whose entire job is to explain
  // why the pack is empty, and 205 tests passed because nothing exercised it. The
  // only signal was a lint warning about an unused import.
  const msg = retrievalFailedMessage('abcdef1234567890abcdef1234567890abcdef12', 7);
  assert.match(msg, /abcdef123/, 'the sha is the whole diagnostic value');
  assert.match(msg, /7 changed file\(s\)/);
  assert.doesNotMatch(msg, /<headSha>/, 'the placeholder must be substituted, not printed');
  assert.match(SHALLOW_CHECKOUT_REMEDY, /fetch-depth: 0/);
});

test('retrievalFailed does not blame the checkout when the BUDGET was simply full', () => {
  // The false positive: file evidence is also dropped for size, so a PR of large
  // files yields zero evidence on a perfectly healthy checkout -- and would have
  // told its author to set fetch-depth: 0 for a problem they do not have.
  const shallow = { fileEvidence: [], truncated: [] };
  const budgetFull = { fileEvidence: [], truncated: ['full content of packages/a/big.ts'] };
  assert.equal(retrievalFailed(shallow, 3), true, 'no evidence and nothing dropped means missing refs');
  assert.equal(retrievalFailed(budgetFull, 3), false, 'evidence dropped for size is not a broken checkout');
  assert.equal(retrievalFailed(shallow, 0), false, 'an empty diff is not a retrieval failure');
});

test('the UNREVIEWABLE list is charged too, not rendered for free', () => {
  // THROUGH buildPack, and with a diff big enough to matter. The first version
  // called the helpers directly, so deleting the fix left every test green; the
  // second went through buildPack but used a tiny diff, where both budgets clamp
  // at MAX_PACK_BYTES and the difference cannot show. A fixture that cannot
  // exhaust the budget cannot test the budget.
  const fileCount = 100;
  const per = 2_000;
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `packages/some/nested/module/file-${i}.ts`,
    patch: `@@ -1,1 +1,2 @@\n+${'x'.repeat(per)}\n`,
  }));
  const patchBytes = files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0);
  const rows = Array.from({ length: 900 }, (_, i) => ({
    path: `vendor/generated/deeply/nested/thing-${i}.ts`,
    reason: 'no patch returned (too large, or a pure rename)',
  }));
  const pack = (unreviewable) =>
    buildPack(
      { headSha: 'a'.repeat(40), files, unreviewable },
      { baseRef: 'HEAD', body: 'B'.repeat(60_000), patchBytes, exec: (_c, a) => (a[0] === 'show' ? 'y'.repeat(4_000) : '') },
    );
  const size = (pk) =>
    Buffer.byteLength(pk.body ?? '', 'utf8') + pk.fileEvidence.reduce((n, e) => n + Buffer.byteLength(e.text, 'utf8'), 0);
  assert.ok(
    size(pack(rows)) < size(pack([])),
    `900 unreviewable rows left the pack the same room (${size(pack(rows))} vs ${size(pack([]))}): rendered free`,
  );
});

test('THE ASSEMBLED PROMPT fits even when most rows are UNREVIEWABLE', () => {
  // The monotonicity check above says the rows cost something; it never says
  // they cost ENOUGH. Charging them at the file rate was still 14,747 bytes over
  // on this exact shape -- 100 reviewable files on a 200 KB diff plus 900
  // unreviewable rows, which is 1,000 files, the paging cap, so no truncation
  // refusal fires either.
  const rubric = readFileSync(join(HERE, 'rubric.md'), 'utf8');
  const files = Array.from({ length: 100 }, (_, i) => ({
    path: `packages/some/nested/module/file-${i}.ts`,
    patch: `@@ -1,1 +1,2 @@\n+${'x'.repeat(2_000)}\n`,
  }));
  const patchBytes = files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0);
  const input = {
    headSha: 'a'.repeat(40),
    files,
    unreviewable: Array.from({ length: 900 }, (_, i) => ({
      path: `vendor/generated/deeply/nested/thing-${i}.ts`,
      reason: 'no patch returned (too large, or a pure rename)',
    })),
  };
  input.contextPack = buildPack(input, {
    baseRef: 'HEAD',
    body: 'B'.repeat(60_000),
    patchBytes,
    exec: (_c, a) => (a[0] === 'show' ? 'y'.repeat(4_000) : ''),
  });
  const bytes = Buffer.byteLength(buildPrompt(rubric, input), 'utf8');
  assert.ok(
    bytes <= MAX_PROMPT_BYTES,
    `the assembled prompt is ${bytes} bytes, over the ${MAX_PROMPT_BYTES} ceiling by ${bytes - MAX_PROMPT_BYTES}`,
  );
});

test('promptEnvelopeBytes AGREES with what buildPrompt actually renders', () => {
  // Two models of one structure in two modules, joined by prose: buildPrompt
  // emits the rows, promptEnvelopeBytes predicts their cost. If buildPrompt grows
  // a third per-item section the prediction silently under-charges and nothing
  // fails -- one layer up from the bug this commit fixed.
  const rubric = readFileSync(join(HERE, 'rubric.md'), 'utf8');
  const mk = (nFiles, nUnrev) => ({
    headSha: 'a'.repeat(40),
    files: Array.from({ length: nFiles }, (_, i) => ({
      path: `packages/some/nested/module/file-${i}.ts`,
      patch: '@@ -1,1 +1,2 @@\n+const x = 1;\n',
    })),
    unreviewable: Array.from({ length: nUnrev }, (_, i) => ({
      path: `vendor/generated/deeply/nested/thing-${i}.ts`,
      reason: 'no patch returned (too large, or a pure rename)',
    })),
  });
  const bare = mk(1, 0);
  for (const [nf, nu] of [[101, 0], [1, 100]]) {
    const grown = mk(nf, nu);
    const actual =
      Buffer.byteLength(buildPrompt(rubric, grown), 'utf8') - Buffer.byteLength(buildPrompt(rubric, bare), 'utf8');
    const patchDelta = grown.files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0)
      - bare.files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0);
    const charged = promptEnvelopeBytes(grown) - promptEnvelopeBytes(bare);
    assert.ok(
      charged >= actual - patchDelta,
      `${nf} files / ${nu} unreviewable: buildPrompt spent ${actual - patchDelta} bytes of structure, ` +
        `promptEnvelopeBytes charged only ${charged}`,
    );
  }
  assert.equal(promptEnvelopeBytes(undefined), PROMPT_BASE_OVERHEAD_BYTES, 'a missing input must not throw');
  assert.equal(promptEnvelopeBytes({}), PROMPT_BASE_OVERHEAD_BYTES);
});

test('a FALSY envelope charges the base reserve rather than dropping it', () => {
  // `|| 0` would have let an explicit 0 or a NaN silently remove the 24,000-byte
  // base and hand back a budget that much too large -- a falsy input failing OPEN
  // in the one function whose job is to keep the prompt small. The previous
  // row-count signature could not do this: a falsy count zeroed the per-file term
  // and left the base standing, so the new signature made a new way to be wrong.
  const patch = 250_000;
  const charged = packBudgetFor(patch, PROMPT_BASE_OVERHEAD_BYTES);
  for (const bad of [NaN, undefined, null, 0]) {
    assert.equal(
      packBudgetFor(patch, bad),
      charged,
      `an envelope of ${String(bad)} produced a different budget: the base reserve was dropped`,
    );
  }
});

test('LONG PATHS: the pack cannot turn a passing prompt into a failing one', () => {
  // The defect a flat per-file charge hid. `buildPrompt` spends 13 + the path's
  // own bytes per row; a flat 70 covers a 57-byte path and this repository has
  // 1,476 of 6,590 tracked paths longer than that, up to 188. Past 57 the
  // envelope was undercharged, packBudgetFor handed back room that did not
  // exist, and the pack spent it for real.
  //
  // Measured on the pre-fix code: 1,000 files with 110-byte paths on a 248 KB
  // diff gave 381,865 bytes diff-only -- UNDER the ceiling -- and 430,410 with
  // the pack, over by 40,410. The committed fixtures all used ~55-byte paths, so
  // every existing test sat on the safe side of the cliff.
  const rubric = readFileSync(join(HERE, 'rubric.md'), 'utf8');
  const deep = 'packages/some/very/deeply/nested/generated/module/directory/tree';
  // 700, not 1,000: the roster now spends every path a second time, and at
  // 1,000 files BOTH cases sat over the ceiling diff-only, so `continue`
  // skipped the assertion in every iteration and the test measured nothing.
  // The counter below is what keeps that from happening again.
  let exercised = 0;
  for (const pathLen of [110, 188]) {
    const files = Array.from({ length: 700 }, (_, i) => {
      const stem = `${deep}/file-${i}`;
      const p = (stem + 'x'.repeat(Math.max(0, pathLen - stem.length - 3))).slice(0, pathLen - 3) + '.ts';
      return { path: p, patch: `@@ -1,1 +1,2 @@\n+${'x'.repeat(230)}\n` };
    });
    const patchBytes = files.reduce((n, f) => n + Buffer.byteLength(f.patch, 'utf8'), 0);
    const input = { headSha: 'a'.repeat(40), files, unreviewable: [] };
    const bare = Buffer.byteLength(buildPrompt(rubric, input), 'utf8');
    if (bare > MAX_PROMPT_BYTES) continue; // only the case where diff-only PASSES matters

    const withPack = { ...input };
    withPack.contextPack = buildPack(input, {
      baseRef: 'HEAD',
      body: 'B'.repeat(60_000),
      patchBytes,
      exec: (_c, a) => (a[0] === 'show' ? 'y'.repeat(4_000) : ''),
    });
    const full = Buffer.byteLength(buildPrompt(rubric, withPack), 'utf8');
    assert.ok(
      full <= MAX_PROMPT_BYTES,
      `${pathLen}-byte paths: diff-only was ${bare} (under ${MAX_PROMPT_BYTES}), with the pack ` +
        `${full}, over by ${full - MAX_PROMPT_BYTES}. The pack made a passing prompt fail.`,
    );
    exercised += 1;
  }
  assert.ok(exercised >= 1, 'every case skipped as over-ceiling diff-only; the assertion never ran');
});

test('promptEnvelopeBytes scales with PATH LENGTH, not just row count', () => {
  const short = { files: Array.from({ length: 100 }, () => ({ path: 'a/b.ts' })) };
  const long = { files: Array.from({ length: 100 }, () => ({ path: `a/${'p'.repeat(180)}.ts` })) };
  assert.ok(
    promptEnvelopeBytes(long) > promptEnvelopeBytes(short) + 100 * 150,
    'a hundred long paths must be charged far more than a hundred short ones',
  );
  // The unreviewable side scales too: buildPrompt renders the path AND the reason
  // per row, and a flat charge undercounts both the same way it did for files.
  const shortU = { unreviewable: Array.from({ length: 100 }, () => ({ path: 'v/x.ts', reason: 'deleted' })) };
  const longU = {
    unreviewable: Array.from({ length: 100 }, () => ({
      path: `vendor/${'p'.repeat(170)}.ts`,
      reason: 'no patch returned (too large, or a pure rename)',
    })),
  };
  assert.ok(
    promptEnvelopeBytes(longU) > promptEnvelopeBytes(shortU) + 100 * 150,
    'a hundred long unreviewable rows must cost far more than a hundred short ones',
  );
});

test('THE OTHER DIRECTION: an inflated envelope must not starve the pack', () => {
  // A threshold has two directions and the suite probed one. Every guard here
  // asserts the envelope is charged ENOUGH; inflating a constant -- say
  // PROMPT_UNREVIEWABLE_ROW_FIXED to a billion -- silently drove the budget to
  // zero for any PR with unreviewable files, which is the inert-pack failure this
  // whole branch exists to prevent, and it passed every test.
  //
  // So: an ordinary PR must still get a real pack. This is deliberately loose --
  // it is a floor against absurdity, not a tuning knob.
  const ordinary = {
    files: Array.from({ length: 12 }, (_, i) => ({ path: `packages/data/src/module-${i}.ts` })),
    unreviewable: Array.from({ length: 3 }, (_, i) => ({ path: `pkg/gen-${i}.ts`, reason: 'generated' })),
  };
  const envelope = promptEnvelopeBytes(ordinary);
  assert.ok(
    envelope < MAX_PROMPT_BYTES / 4,
    `the envelope for a 12-file PR is ${envelope}, over a quarter of the whole prompt ceiling`,
  );
  assert.equal(
    packBudgetFor(40_000, envelope),
    MAX_PACK_BYTES,
    'a 40 KB diff on a 12-file PR must still receive the FULL pack',
  );
});
