#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/generate-coverage-ledger.mjs.
 *
 * Method matches scripts/check-legacy-entity-coverage.test.mjs: copy the REAL
 * source files this generator reads into a temp tree, run the UNMODIFIED
 * generator against it via `--root`, and assert exit code / output. Two
 * shapes are covered: (1) a source mutated to zero matches must make the
 * generator FAIL LOUDLY (the vacuity guard), not emit an empty ledger; (2) a
 * source mutated to a DIFFERENT non-empty answer must change the rendered
 * ledger, so `--check` against the old committed file goes red.
 *
 * Run: node --test scripts/generate-coverage-ledger.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const GENERATOR = join(SCRIPTS, 'generate-coverage-ledger.mjs');
const HELPER = join(SCRIPTS, 'check-legacy-entity-coverage.mjs');

const SOURCE_RELS = [
  'packages/data/src/ifc-schema/generated/entities-ifc2x3.ts',
  'packages/data/src/ifc-schema/generated/entities-ifc4.ts',
  'packages/data/src/ifc-schema/generated/entities-ifc4x3.ts',
  'rust/core/src/generated/schema.rs',
  'rust/core/src/legacy_entities.rs',
  'packages/data/src/relationship-graph.ts',
  'rust/geometry/src/router/processor_registry.rs',
  'packages/create/src/ifc-creator.ts',
  'packages/export/src/schema-converter.ts',
];

const IN_STORE_DIR = 'packages/create/src/in-store';
const FIXTURE_REL = 'apps/landing/samples/hello-wall.ifc'; // FILE_SCHEMA(('IFC4'))

/** Slices out one `## SCHEMA` section's rows from a rendered ledger, so a
 * test can assert on the row for a specific schema rather than accidentally
 * picking up the first same-named row from a different section (#4474: the
 * fixture column is now schema-scoped, so which section a row comes from is
 * load-bearing for what it should say). */
function sectionOf(ledger, schema) {
  const start = ledger.indexOf(`## ${schema}\n`); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.notEqual(start, -1, `test anchor drifted — no "## ${schema}" section in the rendered ledger`);
  const nextHeading = ledger.indexOf('\n## ', start + 1); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  return ledger.slice(start, nextHeading === -1 ? ledger.length : nextHeading);
}

const real = new Map();
for (const rel of SOURCE_RELS) real.set(rel, readFileSync(join(ROOT, rel), 'utf8'));
const realFixture = readFileSync(join(ROOT, FIXTURE_REL), 'utf8');

const realGeneratorSrc = readFileSync(GENERATOR, 'utf8');

/** Regenerates the coverage ledger against the REAL repo root (the full,
 * committed fixture corpus across all schemas — not the trimmed single-file
 * corpus `runOn()` uses), and returns the freshly rendered ledger text. */
function regenerateAgainstRealRoot() {
  const r = spawnSync(process.execPath, [GENERATOR, '--root', ROOT], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`generator failed against the real repo root: ${r.stdout}${r.stderr}`);
  }
  return readFileSync(join(ROOT, 'docs/architecture/coverage-ledger.md'), 'utf8');
}

/** The FILE_SCHEMA a committed `.ifc` fixture (absolute path) itself
 * declares in its header, normalised to this ledger's section keys — the
 * SAME normalisation `generate-coverage-ledger.mjs` applies (IFC4X3_ADD2 /
 * _RC* collapse onto IFC4X3), kept here so a test can independently verify
 * the generator attributed a fixture to the right section, not by re-using
 * its logic as the oracle. */
function fixtureDeclaredSchema(absPath) {
  const text = readFileSync(absPath, 'utf8');
  const m = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/); // @source-text-assertion-ok reads a committed .ifc fixture's OWN header, independently of the generator, as the oracle a behavioural cross-check verifies the generator's output against — not the generator's unexecuted source
  const header = m ? m[1].toUpperCase() : null;
  if (header === 'IFC2X3' || header === 'IFC4') return header;
  if (header && /^IFC4X3(_ADD\d+|_RC\d+)?$/.test(header)) return 'IFC4X3'; // @source-text-assertion-ok reads a committed .ifc fixture's OWN header, independently of the generator, as the oracle a behavioural cross-check verifies the generator's output against — not the generator's unexecuted source
  return null;
}

/** Writes a (possibly mutated) tree to a temp dir, including the helper
 * script the generator imports, and runs the generator on it. `generatorSrc`
 * lets a test run a MUTATED copy of the generator itself (not just its input
 * sources), for mutation-testing the generator's own logic. */
function runOn(overrides = {}, generatorSrc = realGeneratorSrc) {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-ledger-'));
  try {
    for (const [rel, content] of real) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, overrides[rel] ?? content);
    }
    // in-store dir: copy every real file so the generator's fixed file list
    // resolves at least one (its own vacuity guard on this set).
    const inStoreAbs = join(dir, IN_STORE_DIR);
    mkdirSync(inStoreAbs, { recursive: true });
    const wallSrc = readFileSync(join(ROOT, IN_STORE_DIR, 'wall.ts'), 'utf8');
    writeFileSync(join(inStoreAbs, 'wall.ts'), overrides[`${IN_STORE_DIR}/wall.ts`] ?? wallSrc);

    // fixture corpus: copy one real committed sample into the FIRST fixture
    // directory the generator scans, so its own vacuity guard on the corpus
    // resolves at least one class. `overrides[FIXTURE_REL] === null` omits
    // the file entirely (for the vacuity-guard test below).
    const fixtureOverride = Object.prototype.hasOwnProperty.call(overrides, FIXTURE_REL)
      ? overrides[FIXTURE_REL]
      : realFixture;
    if (fixtureOverride !== null) {
      const fixtureAbs = join(dir, FIXTURE_REL);
      mkdirSync(dirname(fixtureAbs), { recursive: true });
      writeFileSync(fixtureAbs, fixtureOverride);
    }

    // the generator imports its sibling helper by relative path — copy it in
    // next to a copy of the generator itself so `--root` doesn't have to
    // fight import resolution.
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'check-legacy-entity-coverage.mjs'), readFileSync(HELPER, 'utf8'));
    writeFileSync(join(dir, 'scripts', 'generate-coverage-ledger.mjs'), generatorSrc);

    const r = spawnSync(
      process.execPath,
      [join(dir, 'scripts', 'generate-coverage-ledger.mjs'), '--root', dir],
      { encoding: 'utf8' },
    );
    const outPath = join(dir, 'docs/architecture/coverage-ledger.md');
    let out = null;
    try {
      out = readFileSync(outPath, 'utf8');
    } catch {
      // not written — expected on a thrown vacuity guard
    }
    return { status: r.status, log: `${r.stdout}${r.stderr}`, ledger: out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real sources: generator succeeds and produces a non-empty, multi-section ledger', () => {
  const { status, ledger } = runOn();
  assert.equal(status, 0);
  assert.ok(ledger);
  assert.match(ledger, /## IFC2X3/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.match(ledger, /## IFC4X3/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.match(ledger, /\| IfcWall \|/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('writable and fixture columns: known types carry correct, non-vacuous values (#4207)', () => {
  const { status, ledger } = runOn();
  assert.equal(status, 0);
  const header = ledger.split('\n').find((l) => l.startsWith('| Entity |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.match(header, /\| Writable \|/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.match(header, /\| Fixture \|/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text

  // FIXTURE_REL declares FILE_SCHEMA(('IFC4')), so it can only resolve a
  // fixture row in the IFC4 section — the other two sections must see '—'
  // for it (#4474: a fixture is scoped to its OWN declared schema).
  const ifc4Section = sectionOf(ledger, 'IFC4');
  const wallRow = ifc4Section.split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.ok(wallRow, 'test anchor drifted — no IfcWall row in the IFC4 section');
  const wallCols = wallRow.split('|').map((c) => c.trim());
  // Entity|Registry|Retained|Relationships|Geometry|Creatable|Writable|Convertible|Fixture
  assert.equal(wallCols[7], '✅', 'IfcWall is written by IfcCreator.this.line("IFCWALL", ...) — writable must be ✅');
  assert.equal(wallCols[9], FIXTURE_REL, 'IfcWall must resolve to the committed fixture that actually contains an IFCWALL record');

  for (const otherSchema of ['IFC2X3', 'IFC4X3']) {
    const otherSection = sectionOf(ledger, otherSchema);
    const otherWallRow = otherSection.split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
    assert.ok(otherWallRow, `test anchor drifted — no IfcWall row in the ${otherSchema} section`);
    const otherCols = otherWallRow.split('|').map((c) => c.trim());
    assert.equal(
      otherCols[9],
      '—',
      `${otherSchema}'s IfcWall row must NOT cite ${FIXTURE_REL} — that fixture declares IFC4, not ${otherSchema} (#4474)`,
    );
  }

  // Not every writable/fixture value is the SAME as its default — the vacuity trap this test
  // guards against. IfcTable has no dedicated `this.line('IFCTABLE', ...)` writer and never
  // appears in the copied fixture corpus.
  const tableRow = ifc4Section.split('\n').find((l) => l.startsWith('| IfcTable |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.ok(tableRow, 'test anchor drifted — no IfcTable row in the IFC4 section');
  const tableCols = tableRow.split('|').map((c) => c.trim());
  assert.equal(tableCols[7], '❌');
  assert.equal(tableCols[9], '—');
});

test('vacuity guard: no committed fixture in any scanned directory fails loudly', () => {
  const { status, log, ledger } = runOn({ [FIXTURE_REL]: null });
  assert.equal(status, 1);
  assert.match(log, /fixture\(committed \.ifc corpus, any schema\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.equal(ledger, null, 'a vacuity failure must not leave a written ledger behind');
});

test('mutation sensitivity: dropping the IFCWALL this.line() writer flips writable, not creatable (#4207)', () => {
  const src = real.get('packages/create/src/ifc-creator.ts');
  assert.ok(src.includes("this.line(wallId, 'IFCWALL',"), 'test anchor drifted — IFCWALL writer line not found verbatim'); // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  const mutated = src.replace("this.line(wallId, 'IFCWALL',", "this.line(wallId, 'IFCWALLMUTATEDPROBE',");
  assert.notEqual(mutated, src);

  const before = runOn();
  const after = runOn({ 'packages/create/src/ifc-creator.ts': mutated });
  assert.equal(before.status, 0);
  assert.equal(after.status, 0);

  const beforeRow = before.ledger.split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  const afterRow = after.ledger.split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.notEqual(beforeRow, afterRow, 'the mutated line did not actually change the rendered output');
  const beforeCols = beforeRow.split('|').map((c) => c.trim());
  const afterCols = afterRow.split('|').map((c) => c.trim());
  assert.equal(beforeCols[7], '✅');
  assert.equal(afterCols[7], '❌', 'writable must flip once IfcCreator no longer writes an IFCWALL line');
  // IfcWall is still emitted by the in-store wall.ts `editor.addEntity('IfcWall', ...)` builder
  // copied into every run, so creatable must NOT move — proves the probe changed only writable.
  assert.equal(beforeCols[6], '✅');
  assert.equal(afterCols[6], '✅', 'creatable must stay ✅ — the mutation only removed the DEDICATED writer, not every creation path');
});

test('mutation sensitivity: removing the IFCWALL record from the fixture corpus flips fixture (#4207)', () => {
  assert.ok(realFixture.includes('=IFCWALL('), 'test anchor drifted — no IFCWALL record in apps/landing/samples/hello-wall.ifc'); // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  const mutated = realFixture.replace(/=IFCWALL\(/, '=IFCWALLMUTATEDPROBE(');
  assert.notEqual(mutated, realFixture);

  const before = runOn();
  const after = runOn({ [FIXTURE_REL]: mutated });
  assert.equal(before.status, 0);
  assert.equal(after.status, 0);

  // FIXTURE_REL declares IFC4 — only the IFC4 section's IfcWall row can be
  // affected by mutating it (#4474: fixture attribution is schema-scoped).
  const beforeRow = sectionOf(before.ledger, 'IFC4').split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  const afterRow = sectionOf(after.ledger, 'IFC4').split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.notEqual(beforeRow, afterRow, 'the mutated record did not actually change the rendered output');
  const beforeCols = beforeRow.split('|').map((c) => c.trim());
  const afterCols = afterRow.split('|').map((c) => c.trim());
  assert.equal(beforeCols[9], FIXTURE_REL);
  assert.equal(afterCols[9], '—', 'fixture must fall back to — once no scanned corpus file carries an IFCWALL record');
});

test('vacuity guard: emptied processor_registry.rs TYPES array fails loudly, not silently', () => {
  const src = real.get('rust/geometry/src/router/processor_registry.rs');
  assert.ok(src.includes('const TYPES'), 'test anchor drifted — real source no longer has `const TYPES`'); // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  const mutated = src.replace(/const TYPES: \[&\[IfcType\]; \d+\] = \[[\s\S]*?\];/, 'const TYPES: [&[IfcType]; 0] = [];');
  assert.notEqual(mutated, src, 'mutation regex did not match — test anchor drifted');
  const { status, log, ledger } = runOn({ 'rust/geometry/src/router/processor_registry.rs': mutated });
  assert.equal(status, 1);
  assert.match(log, /found ZERO entries/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.equal(ledger, null, 'a vacuity failure must not leave a written ledger behind');
});

test('vacuity guard: emptied relationship-graph.ts names map fails loudly', () => {
  const src = real.get('packages/data/src/relationship-graph.ts');
  const start = src.indexOf('function RelationshipTypeToString'); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  assert.notEqual(start, -1, 'test anchor drifted — RelationshipTypeToString not found');
  const namesStart = src.indexOf('const names:', start); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  const close = src.indexOf('};', namesStart); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  assert.ok(namesStart !== -1 && close !== -1, 'test anchor drifted — names map not bounded');
  const mutated = src.slice(0, namesStart) + 'const names: Record<RelationshipType, string> = {' + src.slice(close);
  const { status, log } = runOn({ 'packages/data/src/relationship-graph.ts': mutated });
  assert.equal(status, 1);
  assert.match(log, /relationships\(RelationshipTypeToString\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('vacuity guard: emptied entities-ifc2x3.ts registry table fails loudly', () => {
  const rel = 'packages/data/src/ifc-schema/generated/entities-ifc2x3.ts';
  const { status, log, ledger } = runOn({ [rel]: '// no rows' });
  assert.equal(status, 1);
  assert.match(log, /registry\(IFC2X3\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.equal(ledger, null, 'a vacuity failure must not leave a written ledger behind');
});

test('vacuity guard: emptied entities-ifc4.ts registry table fails loudly', () => {
  const rel = 'packages/data/src/ifc-schema/generated/entities-ifc4.ts';
  const { status, log } = runOn({ [rel]: '// no rows' });
  assert.equal(status, 1);
  assert.match(log, /registry\(IFC4\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('vacuity guard: emptied entities-ifc4x3.ts registry table fails loudly', () => {
  const rel = 'packages/data/src/ifc-schema/generated/entities-ifc4x3.ts';
  const { status, log } = runOn({ [rel]: '// no rows' });
  assert.equal(status, 1);
  assert.match(log, /registry\(IFC4X3\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('vacuity guard: emptied schema.rs from_str arms fails loudly', () => {
  const rel = 'rust/core/src/generated/schema.rs';
  const src = real.get(rel);
  assert.ok(src.includes('pub fn from_str'), 'test anchor drifted — real source no longer has `pub fn from_str`'); // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  const { status, log } = runOn({ [rel]: '// no from_str fn here' });
  assert.equal(status, 1);
  assert.match(log, /retained\(IFC4X3 from_str arms\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('vacuity guard: emptied legacy_entities.rs match arms fails loudly', () => {
  const rel = 'rust/core/src/legacy_entities.rs';
  const src = real.get(rel);
  assert.ok(/"(IFC[A-Z0-9]+)"\s*=>\s*Some\(/.test(src), 'test anchor drifted — no legacy match arms found'); // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  const { status, log } = runOn({ [rel]: '// no match arms here' });
  assert.equal(status, 1);
  assert.match(log, /retained\(legacy_entities\.rs arms\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('vacuity guard: emptied ifc-creator.ts this.line calls fails loudly', () => {
  const rel = 'packages/create/src/ifc-creator.ts';
  const src = real.get(rel);
  assert.ok(/this\.line\(/.test(src), 'test anchor drifted — no this.line( calls found'); // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  const { status, log } = runOn({ [rel]: '// no this.line() calls here' });
  assert.equal(status, 1);
  assert.match(log, /creatable\(IfcCreator\.this\.line\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('vacuity guard: emptied in-store editor.addEntity calls fails loudly', () => {
  const rel = `${IN_STORE_DIR}/wall.ts`;
  const src = readFileSync(join(ROOT, rel), 'utf8');
  assert.ok(/editor\.addEntity\(/.test(src), 'test anchor drifted — no editor.addEntity( calls in wall.ts'); // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  const { status, log } = runOn({ [rel]: '// no editor.addEntity() calls here' });
  assert.equal(status, 1);
  assert.match(log, /creatable\(in-store editor\.addEntity\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('vacuity guard: emptied IFC2X3_TO_IFC4 rename map fails loudly', () => {
  const rel = 'packages/export/src/schema-converter.ts';
  const src = real.get(rel);
  const start = src.indexOf('const IFC2X3_TO_IFC4'); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  assert.notEqual(start, -1, 'test anchor drifted — const IFC2X3_TO_IFC4 not found');
  const open = src.indexOf('[', src.indexOf('=', start)); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  const close = src.indexOf(']);', open); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  assert.ok(open !== -1 && close !== -1, 'test anchor drifted — IFC2X3_TO_IFC4 not bounded');
  const mutated = src.slice(0, open + 1) + src.slice(close);
  assert.notEqual(mutated, src);
  const { status, log } = runOn({ [rel]: mutated });
  assert.equal(status, 1);
  assert.match(log, /convertible\(IFC2X3_TO_IFC4\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('vacuity guard: emptied IFC4_TO_IFC2X3 rename map fails loudly', () => {
  const rel = 'packages/export/src/schema-converter.ts';
  const src = real.get(rel);
  const start = src.indexOf('const IFC4_TO_IFC2X3'); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  assert.notEqual(start, -1, 'test anchor drifted — const IFC4_TO_IFC2X3 not found');
  const open = src.indexOf('[', src.indexOf('=', start)); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  const close = src.indexOf(']);', open); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  assert.ok(open !== -1 && close !== -1, 'test anchor drifted — IFC4_TO_IFC2X3 not bounded');
  const mutated = src.slice(0, open + 1) + src.slice(close);
  assert.notEqual(mutated, src);
  const { status, log } = runOn({ [rel]: mutated });
  assert.equal(status, 1);
  assert.match(log, /convertible\(IFC4_TO_IFC2X3\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('vacuity guard: emptied IFC4X3_TO_IFC4 rename map fails loudly (#4474 review finding)', () => {
  const rel = 'packages/export/src/schema-converter.ts';
  const src = real.get(rel);
  const start = src.indexOf('const IFC4X3_TO_IFC4'); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  assert.notEqual(start, -1, 'test anchor drifted — const IFC4X3_TO_IFC4 not found');
  const open = src.indexOf('[', src.indexOf('=', start)); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  const close = src.indexOf(']);', open); // @source-text-assertion-ok locates the mutation splice point, not a subject assertion
  assert.ok(open !== -1 && close !== -1, 'test anchor drifted — IFC4X3_TO_IFC4 not bounded');
  const mutated = src.slice(0, open + 1) + src.slice(close);
  assert.notEqual(mutated, src);
  const { status, log, ledger } = runOn({ [rel]: mutated });
  assert.equal(status, 1);
  assert.match(log, /convertible\(IFC4X3_TO_IFC4\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.equal(ledger, null, 'a vacuity failure must not leave a written ledger behind');
});

test('rendered ledger documents the writable and fixture columns, crediting #4208', () => {
  const { ledger } = runOn();
  assert.match(ledger, /\*\*writable\*\*/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.match(ledger, /\*\*fixture\*\*/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.match(ledger, /#4208/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('mutation sensitivity: removing IfcSphere from the geometry TYPES table flips its row', () => {
  const src = real.get('rust/geometry/src/router/processor_registry.rs');
  assert.ok(src.includes('&[IfcType::IfcSphere],'), 'test anchor drifted — IfcSphere line not found verbatim'); // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  const mutated = src.replace('    &[IfcType::IfcSphere],\n', '');
  assert.notEqual(mutated, src);

  const before = runOn();
  const after = runOn({ 'rust/geometry/src/router/processor_registry.rs': mutated });
  assert.equal(before.status, 0);
  assert.equal(after.status, 0);

  const beforeRow = before.ledger.split('\n').find((l) => l.startsWith('| IfcSphere |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  const afterRow = after.ledger.split('\n').find((l) => l.startsWith('| IfcSphere |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.ok(beforeRow && afterRow, 'test anchor drifted — no IfcSphere row in the rendered ledger');
  assert.notEqual(beforeRow, afterRow, 'the mutated line did not actually change the rendered output');
  // Geometry is column 5 (Entity|Registry|Retained|Relationships|Geometry|...).
  assert.match(beforeRow.split('|')[5].trim(), /✅/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.match(afterRow.split('|')[5].trim(), /❌/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
});

test('fixture column: default corpus (only an IFC4 fixture) never leaks it into other schemas\' sections (#4474)', () => {
  // Regression for a confirmed defect in PR #4474: the original `fixture` column pooled every
  // fixture into ONE global map, so an IFC2X3 (or IFC4X3) row could cite a fixture that actually
  // declares FILE_SCHEMA(('IFC4')) — wrong evidence rendered under the wrong schema heading. The
  // default harness corpus here is exactly one fixture, apps/landing/samples/hello-wall.ifc,
  // which declares IFC4 and contains an IFCWALL record. It must resolve ONLY in the IFC4 section.
  const { status, ledger } = runOn();
  assert.equal(status, 0);
  const ifc4Row = sectionOf(ledger, 'IFC4').split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.equal(ifc4Row.split('|').map((c) => c.trim())[9], FIXTURE_REL);
  for (const otherSchema of ['IFC2X3', 'IFC4X3']) {
    const otherRow = sectionOf(ledger, otherSchema).split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
    assert.equal(
      otherRow.split('|').map((c) => c.trim())[9],
      '—',
      `${otherSchema} must not cite ${FIXTURE_REL} — it declares IFC4, not ${otherSchema}`,
    );
  }
});

test('mutation: reverting the fixture lookup to a schema-pooled map reddens the no-leak check, with a probe proving it ran (#4474)', () => {
  const target = "const fixture = fixtureTypeToPathBySchema.get(schema).get(upper) ?? '—';";
  assert.ok(realGeneratorSrc.includes(target), 'test anchor drifted — schema-scoped fixture lookup line not found verbatim'); // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  // Revert to the PRE-#4474-fix shape: look the type up across ALL schemas' maps, ignoring which
  // schema this row belongs to — exactly the bug this whole test file guards against. A probe
  // (`MUTATION_PROBE_FIRED`) is emitted the first time the mutated line runs, so a passing
  // assertion below can't be a no-op mutation that never executed.
  const mutated = realGeneratorSrc.replace(
    target,
    "if (!globalThis.__MUTATION_PROBE_FIRED) { console.error('MUTATION_PROBE_FIRED'); globalThis.__MUTATION_PROBE_FIRED = true; }\n" +
      "    const fixture = [...fixtureTypeToPathBySchema.values()].map((m) => m.get(upper)).find(Boolean) ?? '—';",
  );
  assert.notEqual(mutated, realGeneratorSrc);

  const { status, log, ledger } = runOn({}, mutated);
  assert.equal(status, 0, `mutated generator failed to run: ${log}`);
  assert.match(log, /MUTATION_PROBE_FIRED/, 'probe did not fire — the mutated line never ran'); // @source-text-assertion-ok asserts on the mutated generator's own runtime stderr output, not on unexecuted source text

  // With the schema partitioning reverted, the sole IFC4 fixture leaks into IFC2X3 and IFC4X3
  // too — reproducing the exact #4474 defect (an IFC2X3 row citing an IFC4-declared fixture).
  const ifc2x3Row = sectionOf(ledger, 'IFC2X3').split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.equal(
    ifc2x3Row.split('|').map((c) => c.trim())[9],
    FIXTURE_REL,
    'mutation did not reproduce the leak — test no longer distinguishes the fix from the bug',
  );
});

test('vacuity guard: the real committed corpus resolves at least one fixture per schema section (#4474)', () => {
  // Not a guard inside the generator itself (a real, legitimate zero-fixture schema must not
  // hard-fail CI) — this asserts the CURRENT real corpus is not vacuous in any section, so a
  // silent drift to "every row is —" in one schema is caught here instead of going unnoticed.
  const ledger = regenerateAgainstRealRoot();
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3']) {
    const section = sectionOf(ledger, schema);
    const resolvedCount = section
      .split('\n')
      .filter((l) => l.startsWith('| Ifc')) // @source-text-assertion-ok asserts on the real generator's freshly-regenerated, spawned ledger output (counting resolved rows), not on unexecuted source text
      .map((l) => l.split('|').map((c) => c.trim())[9])
      .filter((fixture) => fixture && fixture !== '—').length;
    assert.ok(
      resolvedCount > 0,
      `fixture(${schema}) resolves ZERO rows in the real corpus — either a real corpus gap (must be ` +
        'documented as an explicit exception) or a regression in schema attribution',
    );
  }
});

test('fixture column: every resolved row in the real ledger cites a fixture declaring THAT ROW\'S OWN schema (#4474)', () => {
  const ledger = regenerateAgainstRealRoot();

  let checkedRows = 0;
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3']) {
    const section = sectionOf(ledger, schema);
    for (const line of section.split('\n')) {
      if (!line.startsWith('| Ifc')) continue; // @source-text-assertion-ok asserts on the real generator's freshly-regenerated, spawned ledger output, not on unexecuted source text
      const cols = line.split('|').map((c) => c.trim());
      const fixture = cols[9];
      if (!fixture || fixture === '—') continue;
      checkedRows++;
      const declared = fixtureDeclaredSchema(join(ROOT, fixture));
      assert.equal(
        declared,
        schema,
        `row under "## ${schema}" cites fixture "${fixture}" whose FILE_SCHEMA declares ` +
          `${declared ?? '(unparseable/unrecognized)'} — cross-schema fixture attribution (#4474)`,
      );
    }
  }
  assert.ok(checkedRows > 0, 'test anchor drifted — no resolved fixture rows found to check across the whole ledger');
});
