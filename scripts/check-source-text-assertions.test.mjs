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
  const r = spawnSync(process.execPath, [GATE], { encoding: 'utf8', cwd: ROOT });
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
