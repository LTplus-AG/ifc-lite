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
import { searchKeys, hunkLines, fileEvidence, MAX_WHOLE_FILE_LINES, buildPack, truncateUtf8, BODY_RESERVE_BYTES, MAX_PACK_BYTES } from './build-context-pack.mjs';

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
  assert.ok(pack.truncated.includes('PR description'));
});

