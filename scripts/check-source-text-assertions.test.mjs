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
import { analyze, blankStrings, stripComments } from './source-text-assertion-detect.mjs';

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
  assert.equal(flagged(`
import { readFileSync } from 'node:fs';
const source = readFileSync('a/b.ts', 'utf8');
const RE = /source\\.includes\\(['"]/;
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
  // Asserted on the BLANKING, not on `flagged`. The first version of this test
  // checked `flagged` with the assertion on a different line, so the corruption
  // never reached the verdict and it passed with the bug live: `a++ / b) / c`
  // blanked to `(a++        c;`, eating the `)` and unbalancing every
  // paren-matching read downstream. Two slashes on one line, so the
  // unterminated-literal fallback does not save it.
  const line = 'const r = (a++ / b) / c;';
  assert.equal(blankStrings(stripComments(line)), line);
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
