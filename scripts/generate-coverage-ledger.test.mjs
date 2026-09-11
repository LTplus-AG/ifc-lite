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
const FIXTURE_REL = 'apps/landing/samples/hello-wall.ifc';

const real = new Map();
for (const rel of SOURCE_RELS) real.set(rel, readFileSync(join(ROOT, rel), 'utf8'));
const realFixture = readFileSync(join(ROOT, FIXTURE_REL), 'utf8');

/** Writes a (possibly mutated) tree to a temp dir, including the helper
 * script the generator imports, and runs the generator on it. */
function runOn(overrides = {}) {
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
    writeFileSync(join(dir, 'scripts', 'generate-coverage-ledger.mjs'), readFileSync(GENERATOR, 'utf8'));

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

  const wallRow = ledger.split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.ok(wallRow, 'test anchor drifted — no IfcWall row in the rendered ledger');
  const wallCols = wallRow.split('|').map((c) => c.trim());
  // Entity|Registry|Retained|Relationships|Geometry|Creatable|Writable|Convertible|Fixture
  assert.equal(wallCols[7], '✅', 'IfcWall is written by IfcCreator.this.line("IFCWALL", ...) — writable must be ✅');
  assert.equal(wallCols[9], FIXTURE_REL, 'IfcWall must resolve to the committed fixture that actually contains an IFCWALL record');

  // Not every writable/fixture value is the SAME as its default — the vacuity trap this test
  // guards against. IfcTable has no dedicated `this.line('IFCTABLE', ...)` writer and never
  // appears in the copied fixture corpus.
  const tableRow = ledger.split('\n').find((l) => l.startsWith('| IfcTable |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.ok(tableRow, 'test anchor drifted — no IfcTable row in the rendered ledger');
  const tableCols = tableRow.split('|').map((c) => c.trim());
  assert.equal(tableCols[7], '❌');
  assert.equal(tableCols[9], '—');
});

test('vacuity guard: no committed fixture in any scanned directory fails loudly', () => {
  const { status, log, ledger } = runOn({ [FIXTURE_REL]: null });
  assert.equal(status, 1);
  assert.match(log, /fixture\(committed \.ifc corpus\)/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
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

  const beforeRow = before.ledger.split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  const afterRow = after.ledger.split('\n').find((l) => l.startsWith('| IfcWall |')); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
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
