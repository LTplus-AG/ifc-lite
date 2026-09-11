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

const real = new Map();
for (const rel of SOURCE_RELS) real.set(rel, readFileSync(join(ROOT, rel), 'utf8'));

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

test('rendered ledger names the deferred writable/fixture columns', () => {
  const { ledger } = runOn();
  assert.match(ledger, /\bwritable\b/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
  assert.match(ledger, /\bfixture\b/); // @source-text-assertion-ok asserts on the real generator's spawned output/emitted ledger, not on unexecuted source text
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
