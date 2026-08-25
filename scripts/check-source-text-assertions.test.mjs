#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-source-text-assertions.mjs and its
 * detector, scripts/source-text-assertion-detect.mjs.
 *
 * The gate shipped with no tests of its own, and then acquired a NARROWING —
 * a predicate now counts only when applied to a value a file read produced.
 * A narrowing is a loosening: it can only ever flag fewer things than before.
 * The gate's own argument is that a check which cannot catch its own
 * regression is not a check, so both halves are pinned here:
 *
 *   1. WHAT IT MUST STILL CATCH — one case per taint shape that occurs in this
 *      repo, plus every predicate spelling, plus the undecidable-flow case
 *      that has to fail closed.
 *   2. WHAT IT MUST NO LONGER CATCH — the subprocess-output shape it used to
 *      false-positive on, and the mixed file that proves the REJECTED repair
 *      (excluding `.stdout`/`.stderr` receivers) would have been wrong.
 *
 * Plus the marker escape hatch, and an end-to-end run against the real repo.
 *
 * Run: node --test scripts/check-source-text-assertions.test.mjs
 * (a named step of the CI node-test job, and covered by its glob catch-all).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './source-text-assertion-detect.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(ROOT, 'scripts', 'check-source-text-assertions.mjs');

const flagged = (src) => analyze(src).flagged;

/** Every fixture names a source file, so SOURCE_LITERAL is never what decides. */
const READ = `const p = 'apps/viewer/src/components/Thing.tsx';`;

// ---------------------------------------------------------------------------
// 1. What the narrowing must still catch: one case per taint shape.

test('direct binding: const source = readFileSync(...) then source.includes', () => {
  assert.ok(
    flagged(`${READ}
const source = readFileSync(p, 'utf8');
assert.ok(source.includes('onRowClick={handleRowClick}'));`),
  );
});

test('read behind a helper: readSource() returning readFileSync', () => {
  assert.ok(
    flagged(`${READ}
function readSource(rel) { return readFileSync(rel, 'utf8'); }
const src = readSource(p);
assert.ok(src.includes('handleRowClick'));`),
  );
});

// The helper in export-ui-parity.test.tsx is annotated; requiring whitespace
// between `)` and `{` once made every TS-annotated helper opaque to the taint.
test('read behind a TS-annotated helper is still followed', () => {
  assert.ok(
    flagged(`${READ}
function readSource(rel: string): string { return readFileSync(rel, 'utf8'); }
assert.ok(readSource(p).includes('handleRowClick'));`),
  );
});

test('read behind a concise arrow helper', () => {
  assert.ok(
    flagged(`${READ}
const readSource = (rel) => readFileSync(rel, 'utf8');
const src = readSource(p);
assert.ok(src.includes('handleRowClick'));`),
  );
});

test('read inside Object.fromEntries(... .map(...))', () => {
  assert.ok(
    flagged(`${READ}
const real = Object.fromEntries(
  Object.entries({ thing: p }).map(([k, rel]) => [k, readFileSync(rel, 'utf8')]),
);
assert.ok(real.thing.includes('handleRowClick'));`),
  );
});

test('read assigned then reassigned', () => {
  assert.ok(
    flagged(`${READ}
let s = readFileSync(p, 'utf8');
s = s.replace(/\\r/g, '');
assert.ok(s.includes('handleRowClick'));`),
  );
});

test('read passed through a function parameter', () => {
  assert.ok(
    flagged(`${READ}
function mutate(source, from) { return source.indexOf(from); }
const real = readFileSync(p, 'utf8');
assert.equal(mutate(real, 'x') >= 0, true);`),
  );
});

test('destructured read', () => {
  assert.ok(
    flagged(`${READ}
const { body } = { body: readFileSync(p, 'utf8') };
assert.ok(body.includes('handleRowClick'));`),
  );
});

// Undecidable flow must fail closed, or the narrowing quietly drops the whole
// mutation-harness shape (a mutator stored in an object and invoked by key).
test('a read handed to a callee the analysis cannot name fails closed', () => {
  assert.ok(
    flagged(`${READ}
const real = readFileSync(p, 'utf8');
function mutate(source, from) { assert.ok(source.includes(from)); return source; }
function run(key, mutations) { return mutations[key](real); }
run('thing', { thing: (s) => mutate(s, 'anchor') });`),
  );
});

// ---------------------------------------------------------------------------
// Every predicate spelling, receiver form and argument form alike.

for (const [name, expr] of [
  ['includes', `source.includes('x')`],
  ['indexOf', `source.indexOf('x')`],
  ['startsWith', `source.startsWith('x')`],
  ['endsWith', `source.endsWith('x')`],
  ['search', `source.search(/x/)`],
  ['match (receiver)', `source.match(/x/)`],
  ['match (argument)', `assert.match(source, /x/)`],
  ['regex .test (argument)', `/x/.test(source)`],
  ['constructed regex .exec (argument)', `new RegExp('x').exec(source)`],
  ['expect().toContain', `expect(source).toContain('x')`],
  ['expect().toMatch', `expect(source).toMatch(/x/)`],
]) {
  test(`predicate spelling still caught: ${name}`, () => {
    assert.ok(flagged(`${READ}\nconst source = readFileSync(p, 'utf8');\n${expr};`), name);
  });
}

// ---------------------------------------------------------------------------
// 2. What the narrowing must no longer catch.

// The shape that reddened PR #3018: reads exist only to seed a temp tree, and
// every assertion is on what the child process printed.
test('subprocess-output-only assertions are not flagged', () => {
  assert.equal(
    flagged(`${READ}
const text = readFileSync(p, 'utf8');
writeFileSync(join(dir, 'copy.ts'), text);
const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
expect(r.stdout).toContain('IFC4: 932 entities');
expect(r.stderr).toContain('Could not find GetPropertiesIFC4');`),
    false,
  );
});

// The rejected repair, refuted executably: excluding `.stdout`/`.stderr`
// receivers would have blinded the gate to files that do BOTH.
test('a file that asserts on stdout AND on file text is still flagged', () => {
  const src = `${READ}
const source = readFileSync(p, 'utf8');
const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
assert.match(r.stdout, /OK/);
assert.ok(source.includes('handleRowClick'));`;
  const result = analyze(src);
  assert.ok(result.flagged, 'the file-text assertion must survive the stdout assertion');
  assert.equal(result.hits.length, 1, 'only the file-text line is a hit');
  assert.match(result.hits[0].text, /source\.includes/);
});

test('a predicate on an untainted receiver is not flagged', () => {
  assert.equal(
    flagged(`${READ}
const text = readFileSync(p, 'utf8');
writeFileSync(out, text);
const names = ['a.tsx', 'b.tsx'];
assert.ok(names.includes('a.tsx'));`),
    false,
  );
});

test('a path predicate on an untainted path is not flagged', () => {
  assert.equal(
    flagged(`${READ}
const text = readFileSync(p, 'utf8');
writeFileSync(out, text);
assert.ok(p.endsWith('.tsx'));`),
    false,
  );
});

// Pre-existing behaviour that the rewrite must not have traded away.
test('a .ts filename mentioned only in prose does not flag', () => {
  assert.equal(
    flagged(`// as per safe-path.test.ts, this reads a wasm binary
/* apps/viewer/src/Thing.tsx is described here, not read */
const wasm = readFileSync('engine.wasm');
assert.ok(String(wasm).includes('x'));`),
    false,
  );
});

test('a file that never names a source file does not flag', () => {
  assert.equal(
    flagged(`const source = readFileSync('fixture.ifc', 'utf8');
assert.ok(source.includes('IFCWALL'));`),
    false,
  );
});

// ---------------------------------------------------------------------------
// 3. The marker escape hatch — the answer to the anchor guard.

const ANCHOR_GUARD = `${READ}
const source = readFileSync(p, 'utf8');
assert.ok(source.includes(anchor), 'mutation anchor drifted');
const out = source.replace(anchor, replacement);`;

test('an anchor guard trips the rule when unmarked', () => {
  assert.ok(flagged(ANCHOR_GUARD), 'the pairing rule must not carve anchor guards out silently');
});

test('a marker on the line above suppresses exactly that assertion', () => {
  const result = analyze(
    ANCHOR_GUARD.replace(
      'assert.ok(source.includes(anchor)',
      '// @source-text-assertion-ok mutation anchor guard, not a subject assertion\nassert.ok(source.includes(anchor)',
    ),
  );
  assert.equal(result.flagged, false);
  assert.equal(result.marked.length, 1);
  assert.match(result.marked[0].reason, /anchor guard/);
  assert.deepEqual(result.unusedMarkers, []);
});

test('a marker on the assertion line itself suppresses it', () => {
  const result = analyze(
    ANCHOR_GUARD.replace(
      "'mutation anchor drifted');",
      "'mutation anchor drifted'); // @source-text-assertion-ok anchor guard",
    ),
  );
  assert.equal(result.flagged, false);
  assert.equal(result.marked.length, 1);
});

test('a marker with no reason suppresses nothing and is reported', () => {
  const result = analyze(
    ANCHOR_GUARD.replace(
      'assert.ok(source.includes(anchor)',
      '// @source-text-assertion-ok\nassert.ok(source.includes(anchor)',
    ),
  );
  assert.ok(result.flagged, 'a reasonless marker must not buy an exemption');
  assert.equal(result.unusedMarkers.length, 1);
});

test('a marker two lines away suppresses nothing and is reported', () => {
  const result = analyze(
    ANCHOR_GUARD.replace(
      'const source = readFileSync',
      '// @source-text-assertion-ok anchor guard\n\nconst source = readFileSync',
    ),
  );
  assert.ok(result.flagged, 'an unattached marker must not blanket the file');
  assert.equal(result.unusedMarkers.length, 1);
});

test('a marker in a file with no assertion at all is reported as dead', () => {
  const result = analyze(`// @source-text-assertion-ok stale, the assertion was converted
const x = 1;`);
  assert.equal(result.flagged, false);
  assert.equal(result.unusedMarkers.length, 1);
});

// ---------------------------------------------------------------------------
// 4. End to end against the real repo.

test('the gate passes on the repo and states its counts', () => {
  // A spawn that never starts, or one that hangs, must not be readable as a
  // gate failure with nothing to say. Without `error`, a failed spawn gives
  // `status: null` and empty stdout/stderr, so the assertion below prints an
  // empty message and the real cause is invisible; without `timeout` a hung
  // gate holds the job until CI kills it.
  const r = spawnSync(process.execPath, [GATE], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 120_000,
  });
  assert.equal(r.error, undefined, `the gate failed to run: ${r.error?.message}`);
  const output = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, output);
  assert.match(
    output,
    /check-source-text-assertions: OK \(\d+ allowlisted, \d+ marked, 0 new\)/,
    'a pass must state the numbers, not merely exit 0',
  );
});

// The set the flat detector found, pinned so the narrowing cannot be shown to
// have dropped a real instance. Every entry is allowlisted with a reason; this
// asserts the DETECTOR still sees them, which the allowlist alone cannot.
test('the narrowing kept every file the flat detector flagged', () => {
  const expected = [
    'apps/viewer/src/components/viewer/colorful-popover-opacity.test.ts',
    'apps/viewer/src/components/viewer/toolbar-parity.test.ts',
    'apps/viewer/src/components/viewer/toolbar/export-ui-parity.test.tsx',
    'apps/viewer/src/hooks/modelLoadedGeometryProps.test.ts',
    'apps/viewer/src/utils/aggregation.test.ts',
    'packages/create-ifc-lite/test/config-fixers.test.ts',
    'packages/geometry/src/prepass-class-spans.test.ts',
  ];
  for (const rel of expected) {
    assert.ok(
      analyze(readFileSync(join(ROOT, rel), 'utf8')).flagged,
      `${rel} was detected by the flat check and must still be detected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Two silent UNDER-detections, both found by review of the narrowing above.
// A gate that stops seeing is worse than one that never looked: it reports
// "no source-text assertion here" for a file that still has one, and the next
// person deletes its allowlist row.
// ---------------------------------------------------------------------------

test('a quote inside a REGEX LITERAL does not blank the rest of the file', () => {
  // `blankStrings` knew about strings and template interpolation but not about
  // regex literals, so the `"` in `/["']/` opened a string that never closed
  // and every assertion after it became invisible. Both halves are asserted:
  // the assertion BEFORE the regex, which always worked, and the one AFTER it.
  assert.equal(flagged(`
    import { readFileSync } from 'node:fs';
    const src = readFileSync('a/b.ts', 'utf8');
    const QUOTED = /["']/;
    it('x', () => { expect(src).toContain('token'); });
  `), true);
});

test('a regex literal holding a quote is still blanked, not read as code', () => {
  // The other direction of the regex fix. This file DOES read a source file and
  // DOES contain a predicate spelling, so it reaches `blankStrings` and would be
  // flagged if the regex body were scanned as code -- the earlier version of
  // this test had no read, so `analyze` returned at the `READS_A_FILE` guard
  // before `blankStrings` ran, and it passed for three unrelated reasons.
  //
  // And then a FOURTH: the body was spelled `source\.includes\(`, which does not
  // contain the `.includes(` that `PREDICATE_METHOD` looks for, so scanning it as
  // code found nothing either way. Disabling regex blanking outright left the
  // whole 64-test suite green. The token below is unescaped on purpose, so the
  // body really is a predicate on a tainted receiver if it is ever read as code.
  assert.equal(flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
const RE = /source.includes()["']/;
it('x', () => { expect(RE.source).toBe('literal'); });
`), false);
});

test('a DOTTED read starts taint, like a bare one', () => {
  // `valueIdentifiers` drops any name preceded by `.`, so `fs.readFileSync(p)`
  // yielded `{fs, p}` and taint never started. `READS_A_FILE` still matched, so
  // the file was ANALYSED rather than skipped and the answer was a confident
  // `flagged: false`. Namespaced reads are the ordinary spelling in this repo.
  assert.equal(flagged(`
    import fs from 'node:fs';
    const src = fs.readFileSync('a/b.ts', 'utf8');
    it('x', () => { expect(src).toContain('token'); });
  `), true);
});

test('an awaited namespaced read starts taint too', () => {
  assert.equal(flagged(`
    import fsp from 'node:fs/promises';
    const src = await fsp.readFile('a/b.ts', 'utf8');
    it('x', () => { expect(src).toContain('token'); });
  `), true);
});

test('a file with no read at all is still not flagged', () => {
  // The control for both fixes above. Neither may be satisfiable by flagging
  // everything: a predicate applied to a literal is not a source-text
  // assertion, and that is the whole point of the narrowing.
  assert.equal(flagged(`
    const src = 'a literal, not a file';
    it('x', () => { expect(src).toContain('token'); });
  `), false);
});

test('a marker excuses a WRAPPED assertion, written as the gate prints it', () => {
  // The remedy `check-source-text-assertions.mjs` prints puts the marker above
  // `assert.ok(...)`. On a wrapped call the predicate is two lines below it, so
  // the marker excused nothing AND was reported unused: CI failed twice and the
  // printed fix did not work. A remedy an instrument prints must be one the
  // instrument accepts.
  const r = analyze(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
// @source-text-assertion-ok anchor guard, not a subject assertion
assert.ok(
  source.includes(anchor),
  \`anchor drifted\`,
);
`);
  assert.equal(r.flagged, false);
  assert.equal(r.marked.length, 1);
  assert.deepEqual(r.unusedMarkers, []);
});

test('a marker that excuses nothing is still an unused marker', () => {
  // The control for the widening above. Reaching further up must not turn the
  // marker into a blanket exemption: one attached to unrelated code still has
  // to be reported, or "marked sites stay named" stops being true.
  // The separator matters. `const unrelated = 1;` ends in `;`, which the walk
  // already rejects, so it certified nothing. A COMMENT is the case that broke
  // it: `CONTINUES` contains `*`, `/`, `:` and `-`, so an ordinary `// Arrange:`
  // or this repo's own `// -----` separator read as a continuation and let a
  // stale marker reach an unrelated predicate -- while ALSO marking it used, so
  // the dead-marker check went quiet.
  //
  // The last two are why the walk reads `stripComments` output rather than a
  // per-line stripper of its own: a TRAILING block comment leaves the line
  // ending in `/`, and truncating at the `//` of a URL leaves it ending in `:`.
  // Both are accepted by `CONTINUES`, so both let the marker reach further --
  // a per-line stripper made the gate WORSE on them, not merely no better.
  // Those two are also the only entries that DISCRIMINATE: restore the old
  // per-line stripper and only they go red. The other four stay green under
  // that mutation and are here as coverage, not as a pin.
  //
  // A bare ` */` used to be in this list and was REMOVED, which is a loosening
  // and so belongs on the record rather than in a commit message. An orphan
  // `*/` has no opener, so `stripComments` leaves it whole, it ends in `/`,
  // and the marker now reaches ACROSS it -- excusing a predicate and marking
  // itself used, both halves silent. It is dropped because no valid JS puts a
  // bare `*/` on the walk path (a real one always has an opener above, and the
  // balanced case below is handled), not because the gate holds there. If
  // `stripComments` ever learns to handle unbalanced blocks, this is open.
  for (const separator of [
    '// Arrange:',
    '// ------------------',
    '// see https://x/',
    '/** a balanced block */',
    'const unrelated = 1; /* trailing block */',
    'const url = "http://x";',
  ]) {
    const r = analyze(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
// @source-text-assertion-ok nothing here to excuse
${separator}
it('x', () => { expect(source).toContain('token'); });
`);
    assert.equal(r.flagged, true, `separator ${separator} let a stale marker through`);
    assert.equal(r.unusedMarkers.length, 1, `separator ${separator} hid the unused marker`);
  }
});

test('a JSX closing tag does not open a regex', () => {
  // `</Foo>` puts `<` directly before the slash. Accepting `<` as a regex
  // preceder made every closing tag open one, and on a line with a second `/`
  // the span swallowed an opening quote and blanked the rest of the FILE --
  // the exact whole-file desync the regex handling was added to remove.
  assert.equal(flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
render(<Foo trigger={<button>Open</button>} src="img/x.png" />);
assert.ok(source.includes('handleRowClick'));
`), true);
});

test('division after ++ is not read as a regex', () => {
  // This used to assert on the BLANKING, because the hand-rolled lexer read
  // `a++ / b) / c` as a regex, blanked it to `(a++        c;`, and ate the `)`
  // -- and an earlier version that checked `flagged` with the assertion on a
  // different line passed with that bug live, because the corruption never
  // reached the verdict.
  //
  // There is no blanking to assert on now (#3174): TypeScript decides regex
  // versus division in the parser. So the property is stated where it is
  // observable, in BOTH directions on the same input, which is what the
  // earlier one-sided version lacked -- a rewrite that only checked the
  // flagged case would pass on a detector that flags everything.
  const hazard = 'const r = (a++ / b) / c;';
  assert.equal(flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
${hazard}
assert.ok(source.includes('tok'));
`), true, 'a division after ++ swallowed the assertion below it');
  assert.equal(flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
${hazard}
assert.ok(other.includes('tok'));
`), false, 'the same file with an UNTAINTED subject must stay clean');
});

// ---------------------------------------------------------------------------
// 6. Fail-open holes CodeRabbit found on the PR head, and their siblings.
//    All five are the dangerous direction: the gate going SILENT on a real
//    source-text assertion, which is indistinguishable from a clean file.

test('a `//` inside a STRING does not blank the rest of the file', () => {
  // Comments were stripped by a regex that could not see strings, so
  // `'see // the docs'` truncated to an unterminated quote and the string
  // lexer blanked everything after it. No marker involved: the assertion two
  // lines down simply became invisible and the file reported clean.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
const doc = 'see // the docs';
assert.ok(source.includes('token'));
`),
    true,
  );
});

test('a marker inside a STRING LITERAL excuses nothing', () => {
  // Markers were matched against RAW lines, so any string containing the
  // marker text suppressed a real finding. A string is not a comment.
  const r = analyze(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
const doc = 'write @source-text-assertion-ok fake to suppress';
assert.ok(source.includes('token'));
`);
  assert.equal(r.flagged, true, 'a string suppressed a real finding');
  assert.deepEqual(r.marked, [], 'a string was accepted as a marker');
});

test('a REAL comment marker still excuses, so the fix is not a blanket refusal', () => {
  // The control for the two above. Without it, deleting marker support
  // entirely would pass them both.
  const r = analyze(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
// @source-text-assertion-ok anchor guard
assert.ok(source.includes('token'));
`);
  assert.equal(r.flagged, false);
  assert.equal(r.marked.length, 1);
});

test('an iteration callback carries the bytes one element at a time', () => {
  // `source.split('\n').some((line) => line.includes(x))` reads a file and
  // asserts on its text, but no tainted NAME appears inside the callback, so
  // the predicate looked like it applied to a clean parameter.
  for (const body of [
    "assert.ok(source.split('\\n').some((line) => line.includes('x')));",
    "const hit = (line) => line.includes('x');\nassert.ok(source.split('\\n').some(hit));",
    "for (const line of source.split('\\n')) { assert.ok(line.includes('x')); }",
  ]) {
    assert.equal(
      flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
${body}
`),
      true,
      `this shape escaped the detector: ${body}`,
    );
  }
});

test('a path loop is not tainted just because the path list is', () => {
  // The bound on the rule above. `files` IS tainted here -- it is derived from
  // a tainted value, and this analysis has no way to know the derivation
  // produced PATHS rather than contents. Tainting every `for..of` whose
  // iterable carries file bytes therefore also taints `file`, and
  // `file.endsWith('.ts')` becomes a false hit: measured as 4 of them in
  // apps/viewer/src/components/viewer/toolbar-parity.test.ts, whose line 323
  // is exactly `for (const file of files)`.
  //
  // Nothing lexical separates a tainted array of lines from a tainted array of
  // filenames, so the rule takes only the `.split(` it can prove. Widen it and
  // this reds.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const root = readFileSync('cfg.json', 'utf8');
const files = walk(root);
for (const file of files) {
  assert.ok(file.endsWith('.test.ts'));
}
`),
    false,
    'a loop over PATHS derived from file bytes was read as a source-text assertion',
  );
});

test('a regex directly after a block comment does not blank the file', () => {
  // `regexLiteralEnd` decides regex-vs-division from the previous significant
  // character. Reading that from RAW text puts the `/` of a preceding `*/` in
  // front of the literal, so `/["']/` read as division, the `"` opened a
  // string that never closed, and everything below went invisible. The
  // backward scan therefore reads the output-so-far, where comments are
  // already spaces. Route the lookback back through raw text and this reds.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
const a = 1; /* c */ /["']/.test(z);
assert.ok(source.includes('tok'));
`),
    true,
  );
});

test('a call chained before .split does not hide the loop', () => {
  // The iterable is read to the `)` MATCHING the for-header's `(`. Capturing
  // it with `[^)]*` stopped inside `source.trim().split('\n')` at the `)` of
  // `trim(`, so the `.split(` was never seen.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
for (const line of source.trim().split('\\n')) { assert.ok(line.includes('x')); }
`),
    true,
  );
});

test('an anonymous function callback carries taint like an arrow', () => {
  // Same flow, different spelling. Matching only `=>` left it undetected.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
assert.ok(source.split('\\n').some(function (line) { return line.includes('x'); }));
`),
    true,
  );
});

test('division BY a regex literal does not desync the lexer', () => {
  // The blanked view keeps a regex's opening `/`. Blanking the literal whole
  // made the following division look back PAST it to the `=`, call itself a
  // regex, run forward into the next string for its "closing" slash, and blank
  // the rest of the file. Nonsense code, but the failure is silence, and the
  // guard costs one character.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
const n = /a/ / b; const s = 'q/w';
assert.ok(source.includes('tok'));
`),
    true,
  );
});

test('the for-of iterable keeps its last character', () => {
  // `matchParen` returns the index OF the `)`, not just past it -- its
  // docstring said the opposite and this code trusted the docstring, so an
  // extra `- 1` chopped the iterable's final character.
  //
  // The tainted name is LAST here on purpose. The first version of this test
  // used `(src).split('\\n')`, where chopping the trailing `)` still left
  // `src` in the slice, so it passed with the bug live -- a fixture that could
  // not fail. Chopping `|| src` to `|| sr` loses the only tainted name.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const src = readFileSync('a/b.ts', 'utf8');
const sep = 'x';
const other = '';
for (const line of other.split(sep) || src) { assert.ok(line.includes('y')); }
`),
    true,
  );
});

// ---------------------------------------------------------------------------
// 7. Review-bot findings on #3116. All four were silent under-detection, and
//    each has a control that behaved correctly before the fix, so the fixture
//    distinguishes the bug from the shape.

test('a single arrow parameter needs no parentheses', () => {
  // `fnRe` required a `(`, so `const check = src => …` registered no function
  // and the call site never tainted `src`, while `(src) => …` was caught.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
const check = src => src.includes('x');
assert.ok(check(source));
`),
    true,
  );
});

test('a regex as an unbraced control body is not division', () => {
  // `)` is not a regex-preceder, because `(a + b) / c` IS division. But an
  // unbraced `if` body can be a regex expression statement, and reading that as
  // division let the `"` open a string that never closed.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
if (ok) /["']/.test(value);
assert.ok(source.includes('tok'));
`),
    true,
  );
  // The control: a genuine division after `)` must stay division. Stated on
  // the verdict now rather than on a blanked view (#3174) -- if that `/ 3;`
  // opened a regex, everything to the next `/` would be one token and the
  // assertion below would vanish with it.
  assert.equal(flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
const q = (1 + 2) / 3;
assert.ok(source.includes('tok'));
`), true, 'a genuine division was read as a regex and ate the assertion');
});

test('a helper whose name contains $ is still followed', () => {
  // `$` is legal in a JS identifier and is NOT a word character, so `\b` never
  // matched in front of a leading `$`: `$read(x)` yielded `read`, which is not
  // in the tainted set. `a.$b` lost its dot marker the same way, turning a
  // property into a value.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
function $read(p) { return readFileSync(p, 'utf8'); }
const s2 = $read('a.ts');
assert.ok(s2.includes('x'));
`),
    true,
  );
});

test('taint propagation is not cut short by a fixed pass cap', () => {
  // Bindings declared in REVERSE order resolve one link per pass, so a fixed
  // cap of 8 stopped an eight-link chain and reported a clean file. The bound
  // is now derived from the input, which it cannot need to exceed.
  const links = 12;
  const chain = Array.from({ length: links }, (_, i) => `const v${links - i} = v${links - i - 1};`);
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
${chain.join('\n')}
const v0 = readFileSync('a.ts', 'utf8');
assert.ok(v${links}.includes('x'));
`),
    true,
  );
});

test('a $-named helper propagates taint into its PARAMETER', () => {
  // Distinct from the `$read` test above, which reaches the verdict through the
  // helper's RETURN value. This one goes through `callRe`, where `$` broke the
  // pattern twice: as a regex anchor (needs escaping) and as a non-word
  // character (so a leading `\b` can never match). Fixing only the anchor left
  // this silent, and nothing pinned it.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
function $check(text) { assert.ok(text.includes('x')); }
$check(source);
`),
    true,
  );
});

test('the pass bound covers names no binding declares', () => {
  // A `for..of` element is not a binding and not a function, so a cap derived
  // from `bindings.length + fns.length` was SMALLER than the chain it had to
  // resolve -- four reverse-ordered links gave a cap of 3 and reported a clean
  // file, which the fixed 8 it replaced had caught. The bound now counts the
  // distinct identifiers, which is what the loop can actually add.
  const links = 6;
  const chain = Array.from(
    { length: links },
    (_, i) => `for (const v${links - i} of v${links - i - 1}.split('x')) { use(v${links - i}); }`,
  );
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
${chain.join('\n')}
const v0 = readFileSync('a.ts', 'utf8');
assert.ok(v${links}.includes('y'));
`),
    true,
  );
});

test('a control keyword and its ( may sit on different lines', () => {
  // `closesAControlHeader` skipped only spaces and tabs, so a newline between
  // `if` and `(` made the header read as an ordinary parenthesised expression.
  // The regex after it became division and its quote desynced the lexer.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
if
(ok) /["']/.test(value);
assert.ok(source.includes('tok'));
`),
    true,
  );
});

test('an optional call is still a call', () => {
  // `?.(` bypassed all three call patterns, including the FAIL-CLOSED rule for
  // flow this analysis cannot follow -- a guard that exists to catch the
  // unfollowable was itself sidestepped by two characters. `?.` can also sit on
  // either side of a method name.
  for (const body of [
    "function check(text) { assert.ok(text.includes('x')); }\ncheck?.(source);",
    "assert.ok(source.split('x')?.some((line) => line.includes('y')));",
    "mutators[key]?.(source);\nconst cb = (t) => assert.ok(t.includes('x'));",
  ]) {
    assert.equal(
      flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
${body}
`),
      true,
      `optional call escaped: ${body}`,
    );
  }
});

test('a quoted string cannot cross a line', () => {
  // The hand-rolled string state ended only on the matching quote, so ONE
  // unpaired `'` or `"` kept the lexer inside a string until the next quote
  // anywhere later in the file, and every read, filename literal and predicate
  // in that span disappeared -- a whole file silently unscanned.
  //
  // Stated on the verdict now rather than on a blanked view (#3174). A quoted
  // string cannot cross a newline, so the assertion two lines down must still
  // be seen; a TEMPLATE literal may, so a predicate written INSIDE one is
  // string content and must not be.
  assert.equal(flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
const bad = ';
assert.ok(source.includes('tok'));
`), true, 'an unpaired quote swallowed the following lines');
  assert.equal(flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
const t = \`a
assert.ok(source.includes('tok'));
b\`;
`), false, 'a predicate inside a multi-line template is string content, not code');
});

test('a $-leading callback parameter is tainted', () => {
  // `\b` cannot match in front of a leading `$`, so the arrow-parameter pattern
  // captured `line` out of `$line` and the real name stayed clean. Same failure
  // as `valueIdentifiers` and `callRe`, in the third place it appears.
  assert.equal(
    flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
assert.ok(source.split('x').some($line => $line.includes('y')));
`),
    true,
  );
});

test('every path that names a value survives a leading $', () => {
  // `$` is legal in a JS identifier and is NOT a word character, so `\b` can
  // never match in front of a leading one. That single language fact produced
  // three separate silent bugs in this module, each found independently rather
  // than by looking for siblings after the first: `valueIdentifiers`, `callRe`,
  // and both arrow-parameter patterns.
  //
  // This pins the FAMILY. Reintroduce `\b` in front of an identifier class
  // anywhere in the taint analysis and one of these reds, instead of the gate
  // going quiet until someone happens to name a variable `$source`.
  const cases = {
    'binding': "const $src = readFileSync('a.ts', 'utf8');\nassert.ok($src.includes('x'));",
    'let then assign': "let $s;\n$s = readFileSync('a.ts', 'utf8');\nassert.ok($s.includes('x'));",
    'helper return': "function $load(p) { return readFileSync(p, 'utf8'); }\nconst s = $load('a.ts');\nassert.ok(s.includes('x'));",
    'helper parameter': "function $check(t) { assert.ok(t.includes('x')); }\nconst s = readFileSync('a.ts', 'utf8');\n$check(s);",
    'bare arrow helper': "const $chk = $t => $t.includes('x');\nconst s = readFileSync('a.ts', 'utf8');\nassert.ok($chk(s));",
    'for-of element': "const s = readFileSync('a.ts', 'utf8');\nfor (const $line of s.split('n')) { assert.ok($line.includes('x')); }",
    'arrow callback param': "const s = readFileSync('a.ts', 'utf8');\nassert.ok(s.split('n').some($l => $l.includes('x')));",
    'function callback param': "const s = readFileSync('a.ts', 'utf8');\nassert.ok(s.split('n').some(function ($l) { return $l.includes('x'); }));",
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.equal(
      flagged(`
import { readFileSync } from 'node:fs';
${body}
`),
      true,
      `a $-leading name went undetected via: ${name}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 8. What parsing bought, and what it must not have cost (#3174).
//
// The three gaps below were found and measured while working on #3116 and left
// in place because each needed more than that PR's scope. They were recorded
// only in a commit message and a PR body, which is the failure shape this repo
// keeps paying for. Here they are, executable.

test('gap 1: a comment inside a wrapped assertion no longer kills the marker', () => {
  // `markerLineFor` walked up over lines a regex called continuations. An
  // interior comment strips to blank, which is not a continuation, so the walk
  // stopped there and the marker above the assertion never reached the
  // predicate. The gate then failed TWICE in the same run -- "source-text
  // assertion found" and "marker that excuses nothing" -- and the remedy it
  // prints in its own error text did not clear it.
  const result = analyze(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.tsx', 'utf8');
// @source-text-assertion-ok anchor guard
assert.ok(
  // the anchor must exist before we replace it
  source.includes(anchor),
);
`);
  assert.equal(result.flagged, false, 'the marker still does not reach past an interior comment');
  assert.equal(result.marked.length, 1);
  assert.deepEqual(result.unusedMarkers, [], 'the marker must not also be reported as dead');
});

test('gap 1: the fix must NOT be the fail-open one that was measured and rejected', () => {
  // Making blank lines transparent to the walk closes gap 1 and opens a hole:
  // a marker whose guard was deleted then reaches DOWN across blank lines to an
  // unrelated predicate, turning a dead marker (loud) into a silent exemption.
  // The marker's reach is the ENCLOSING STATEMENT, and a different statement is
  // a different range, so no amount of blank line brings this one into scope.
  const result = analyze(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.tsx', 'utf8');
// @source-text-assertion-ok anchor guard



assert.ok(source.includes('handleRowClick'));
`);
  assert.equal(result.flagged, true, 'a marker reached across blank lines and excused a real finding');
  assert.equal(result.marked.length, 0);
  assert.equal(result.unusedMarkers.length, 1, 'the orphaned marker must still be reported');
});

test('gap 3: a default parameter containing a call no longer hides the callback parameter', () => {
  // Callback parameter lists were captured with `[^()]*`, which cannot cross
  // the nested parens of `(line = pad(1))`. The parameter was never tainted, so
  // the entire callback body read as clean -- in BOTH spellings. The plain
  // forms are here as the control: they passed before, and a rewrite that
  // flagged everything would satisfy the defaulted cases alone.
  const head = `
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.tsx', 'utf8');
`;
  const bodies = {
    'function (line)': `assert.ok(source.split('\\n').some(function (line) { return line.includes('TODO'); }));`,
    'function (line = pad(1))': `assert.ok(source.split('\\n').some(function (line = pad(1)) { return line.includes('TODO'); }));`,
    '(line) =>': `assert.ok(source.split('\\n').some((line) => line.includes('TODO')));`,
    '(line = pad(1)) =>': `assert.ok(source.split('\\n').some((line = pad(1)) => line.includes('TODO')));`,
    '({ text: line = pad(1) }) =>': `assert.ok(source.split('\\n').some(({ text: line = pad(1) }) => line.includes('TODO')));`,
  };
  for (const [label, body] of Object.entries(bodies))
    assert.equal(flagged(head + body), true, `callback parameter went untainted via: ${label}`);
});

test('gap 2 stays open, and says so out loud', () => {
  // Not a defect being tolerated silently. Widening the for-of rule to "any
  // iterable carrying file bytes" also taints `for (const file of files)` where
  // the elements are PATHS -- measured as 4 new hits in toolbar-parity.test.ts.
  // Nothing in the SYNTAX separates a tainted array of lines from a tainted
  // array of filenames, so parsing does not close this one either. If a future
  // change makes the bound form flag, this test is the place that says the
  // question was reopened rather than a rule quietly widening.
  const head = `
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.tsx', 'utf8');
`;
  assert.equal(
    flagged(head + `for (const line of source.split('\\n')) { assert.ok(!line.includes('TODO')); }`),
    true,
    'the inline split must still be caught, or this test is measuring nothing',
  );
  assert.equal(
    flagged(head + `const lines = source.split('\\n');\nfor (const line of lines) { assert.ok(!line.includes('TODO')); }`),
    false,
    'gap 2 closed -- if that was deliberate, update this test and the docblock',
  );
});

test('a TYPE ANNOTATION is not a parameter name', () => {
  // The scanning version read parameter names out of the raw text between the
  // parens, so `function rename(file: string, from: RegExp, to: string)`
  // registered `string` and `RegExp` as parameters. Both really were in the
  // taint set of packages/data/scripts/generate-ifc-schema.test.ts on main, and
  // the index misalignment they caused is what tainted a subprocess-output
  // assertion there -- the one false positive the pairing rule exists to
  // prevent.
  //
  // The fixture asserts on a bare `string` on purpose, which no real test would
  // write. That is what makes it DISCRIMINATING: `string` is a name only if the
  // annotation was read as one. An earlier version of this test put the
  // annotation in a slot no tainted argument reached, so it passed on the old
  // detector too and measured nothing.
  const src = `
import { readFileSync } from 'node:fs';
function load(p: string, kind: string) { return kind; }
const s = readFileSync('a.ts', 'utf8');
load('literal', s);
`;
  assert.equal(
    flagged(src + `assert.ok(string.includes('nope'));`),
    false,
    'the annotation `string` was read as a parameter name and got tainted',
  );
  // The control: the parameter that argument REALLY lands in is tainted, so the
  // assertion above is not passing because the call propagated nothing.
  assert.equal(flagged(src + `assert.ok(kind.includes('yes'));`), true);
});

test('an argument taints the parameter it actually lands in', () => {
  // Same root cause as the annotation case: a flat name list has no positions,
  // so argument 1 could taint whatever name happened to sit at index 1 of a
  // list that included annotations. Positional alignment means the SECOND
  // parameter is tainted by the SECOND argument and by nothing else.
  const src = (call) => `
import { readFileSync } from 'node:fs';
function check(clean: string, dirty: string) { assert.ok(dirty.includes('x')); }
const s = readFileSync('a.ts', 'utf8');
${call}
`;
  assert.equal(flagged(src(`check('literal', s);`)), true, 'the tainted argument reached its parameter');
  assert.equal(flagged(src(`check(s, 'literal');`)), false, 'taint landed in the wrong parameter');
});

test('a marker written after the assertion on the same line still excuses it', () => {
  // TypeScript attaches a same-line trailing comment to the PRECEDING token, so
  // it is trailing trivia and not leading trivia of anything. A comment walk
  // that reads only leading ranges loses every marker written this way -- and
  // this is a documented spelling of the escape hatch, so losing it turns a
  // marked site into a hard failure with no way to clear it.
  const result = analyze(`
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.tsx', 'utf8');
assert.ok(source.includes(anchor), 'drifted'); // @source-text-assertion-ok anchor guard
`);
  assert.equal(result.flagged, false);
  assert.equal(result.marked.length, 1);
  assert.deepEqual(result.unusedMarkers, []);
});

test('TypeScript-only syntax between the read and the predicate does not hide it', () => {
  // The scanner had no notion of TS syntax at all -- it saw characters, and a
  // type annotation was only ever "text that happens to sit between parens".
  // These are the spellings a real test file reaches for around a file read,
  // and each one has to leave the taint intact.
  const head = `
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.tsx', 'utf8');
`;
  const shapes = {
    'as cast': `const s = source as string;\nassert.ok(s.includes('x'));`,
    'satisfies': `const s = source satisfies string;\nassert.ok(s.includes('x'));`,
    'non-null': `const s = source!;\nassert.ok(s.includes('x'));`,
    'generic helper': `function id<T>(v: T): T { return v; }\nassert.ok(id(source).includes('x'));`,
    'jsx in the file': `render(<div>{source}</div>);\nassert.ok(source.includes('x'));`,
  };
  for (const [label, body] of Object.entries(shapes))
    assert.equal(flagged(head + body), true, `taint was lost across: ${label}`);
});

test('two fail-opens the rewrite closed on the way past, named so they stay closed', () => {
  // Neither is in #3174's list. Both were live on main, both are silent, and
  // both are gone because the tree answers the question the regexes were
  // approximating -- which is the argument for parsing, stated as two facts
  // instead of as a preference.
  const head = `
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.tsx', 'utf8');
`;

  // A CLASS METHOD as the helper. The function-shape regex matched
  // `function name(` and `const name = (` and nothing else, so a method's
  // parameter was never registered and the call site tainted nothing.
  assert.equal(
    flagged(head + `class C { check(t: string) { return t.includes('x'); } }\nassert.ok(new C().check(source));`),
    true,
    'a class method helper hid the assertion',
  );

  // An OPTIONAL-CHAIN predicate. `\.` matches the dot of `?.`, so the walk back
  // for the receiver started on the `?`, stopped immediately and returned an
  // empty receiver -- `source` was never part of the subject. The detector's
  // own comments describe this exact trap being fixed for the iteration-callback
  // rule; the predicate scan had the same bug and was never revisited. Two
  // characters bought a clean file.
  assert.equal(flagged(head + `assert.ok(source?.includes('x'));`), true, 'an optional-chain predicate escaped');
  assert.equal(flagged(head + `assert.ok(source?.split('n')?.some((l) => l.includes('x')));`), true);
});

test('a callback wrapped in parentheses or a type wrapper is still a callback', () => {
  // Reported by Codex on #3177, and it was a REGRESSION rather than a
  // pre-existing gap: `some(((line) => …))` hands the argument loop a
  // ParenthesizedExpression, so a bare `isFunctionLike` answered no and `line`
  // stayed clean. The scanning version caught every one of these, because its
  // callback pattern matched the arrow wherever it sat in the argument text.
  //
  // Shipping without this would have moved the gate in the one direction it
  // must never move -- quieter -- while the PR claimed the opposite. Each row
  // below was checked against main's detector, and all but the last were green
  // there.
  const head = `
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.tsx', 'utf8');
`;
  const wrapped = {
    'parenthesized arrow': `assert.ok(source.split('n').some(((line) => line.includes('TODO'))));`,
    'as-cast callback': `assert.ok(source.split('n').some(((line) => line.includes('TODO')) as any));`,
    'satisfies callback': `assert.ok(source.split('n').some(((line) => line.includes('TODO')) satisfies unknown));`,
    'parenthesized function expression': `assert.ok(source.split('n').some((function (line) { return line.includes('TODO'); })));`,
    // Not a regression -- main missed this one too -- but the same root cause,
    // so it is closed and pinned with the rest rather than left as a sibling
    // waiting to be found separately.
    'parenthesized hoisted callback': `const hit = (line) => line.includes('TODO');\nassert.ok(source.split('n').some((hit)));`,
    // The declaration side of the same blindness: the arrow's parent is the
    // parenthesis, not the declaration, so the helper had no name at all.
    'wrapped helper declaration': `const chk = ((t) => t.includes('x'));\nassert.ok(chk(source));`,
  };
  for (const [label, body] of Object.entries(wrapped))
    assert.equal(flagged(head + body), true, `a wrapped callback went untainted via: ${label}`);

  // The SECOND round of the same finding, also from Codex on #3177: unwrapping
  // a fixed list of wrappers is not enough, because an expression can SELECT a
  // callback without being one. The scanning version found arrows anywhere in
  // the argument text, so each of these was green on main and red here until
  // the argument is walked rather than root-tested.
  const selected = {
    'ternary': `assert.ok(source.split('n').some(flag ? (line) => line.includes('TODO') : other));`,
    'logical ||': `assert.ok(source.split('n').some(cb || ((line) => line.includes('TODO'))));`,
    'comma operator': `assert.ok(source.split('n').some((noop(), (line) => line.includes('TODO'))));`,
    'spread of a literal': `assert.ok(source.split('n').some(...[(line) => line.includes('TODO')]));`,
    'nested inside a call': `assert.ok(source.split('n').some(wrapCb((line) => line.includes('TODO'))));`,
  };
  for (const [label, body] of Object.entries(selected))
    assert.equal(flagged(head + body), true, `a selected callback went untainted via: ${label}`);

  // A callback passed BY NAME through a selector. Main did NOT catch this one,
  // so it is not a regression -- it is closed here because resolving the
  // selector's branches costs nothing once they are already being walked.
  assert.equal(
    flagged(head + `const hit = (line) => line.includes('TODO');\nassert.ok(source.split('n').some(flag ? hit : other));`),
    true,
    'a named callback behind a ternary went untainted',
  );

  // DEFERRED, and recorded so it is a known hole rather than an assumed one: a
  // callback FACTORY, `some(makeCheck())`, where no function expression appears
  // in the argument at all. Main misses it too, so this PR regresses nothing.
  // Closing it means treating any unresolvable argument as fail-closed, and
  // nothing lexically marks "callback position" -- `source.includes(getAnchor())`
  // has the same shape and is an ordinary assertion, so that rule would taint
  // every parameter in a large share of real test files.
  assert.equal(
    flagged(head + `function makeCheck() { return (line) => line.includes('TODO'); }\nassert.ok(source.split('n').some(makeCheck()));`),
    false,
    'the callback-factory hole closed -- update this test and the docblock if that was deliberate',
  );

  // A wrapped RECEIVER is a different path -- it is read by subtree walk, which
  // descends through the wrapper -- and must keep working.
  assert.equal(flagged(head + `assert.ok((source).includes('x'));`), true);
  assert.equal(flagged(head + `assert.ok((source as string).includes('x'));`), true);

  // And the callee is deliberately NOT unwrapped: `(fn)(source)` is a callee
  // this analysis cannot name, so it must stay in the fail-closed branch that
  // taints every parameter, exactly as the scanning version had it.
  assert.equal(
    flagged(head + `function opaque(t) { assert.ok(t.includes('x')); }\n(opaque)(source);`),
    true,
    'an undecidable callee stopped failing closed',
  );
});

test('an angle-bracket type assertion is a wrapper too, where unwrap is load-bearing', () => {
  // `unwrap` handles `TypeAssertionExpression` and nothing exercised it, because
  // every other fixture parses as TSX and TSX cannot express `<T>value` — it
  // reads as an unclosed JSX tag (2 parse errors, no assertion node). So the
  // branch was dead in the suite while looking covered. Reported by CodeRabbit
  // on #3177 alongside the `?.` guards, which is the other half of the same
  // mistake: a guard would have swallowed a missing predicate and no test
  // reached the path to notice.
  //
  // THE FIRST VERSION OF THIS TEST DID NOT MEASURE THE ARM. It asserted on
  // `const s = <string>source` and on a callback nested inside an assertion,
  // and both stay flagged with the arm deleted — the binding rule and the
  // callback rule each walk the whole subtree, so they descend through the
  // wrapper without needing it removed. Deleting the arm scored the same.
  //
  // The arm is load-bearing exactly where a node is inspected STRUCTURALLY
  // rather than walked: resolving a callback passed BY NAME, and walking from
  // a function up to the name it is bound to. Both of these flip to `false`
  // with the arm removed, which is what makes them the test.
  const head = `
import { readFileSync } from 'node:fs';
const source = readFileSync('Thing.ts', 'utf8');
`;
  const needsUnwrap = {
    'named callback inside an assertion': `const hit = (line) => line.includes('x');\nassert.ok(source.split('n').some(<(l: string) => boolean>hit));`,
    'helper declaration wrapped in one': `const chk = <(t: string) => boolean>((t) => t.includes('x'));\nassert.ok(chk(source));`,
  };
  for (const [label, body] of Object.entries(needsUnwrap))
    assert.equal(analyze(head + body, 'a.ts').flagged, true, `unwrap missed: ${label}`);

  // Kept as controls, and labelled as such: these two are covered by the
  // subtree walks whether or not the arm exists, so they prove the fixtures
  // parse — not that the arm works.
  const coveredByWalks = {
    'binding through an assertion': `const s = <string>source;\nassert.ok(s.includes('x'));`,
    'callback nested inside one': `assert.ok(source.split('n').some(<(l: string) => boolean>((line) => line.includes('x'))));`,
  };
  for (const [label, body] of Object.entries(coveredByWalks))
    assert.equal(analyze(head + body, 'a.ts').flagged, true, `control failed: ${label}`);

  // And the reason the default fileName is TSX: the SAME source parsed as TSX
  // is not this program at all, so a fixture that forgot the filename would be
  // asserting about something else entirely.
  assert.equal(
    analyze(head + coveredByWalks['binding through an assertion'], 'a.tsx').flagged,
    false,
    'TSX now parses `<string>value` — if TypeScript changed, this test measures the wrong thing',
  );
});
