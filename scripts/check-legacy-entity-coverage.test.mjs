#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-legacy-entity-coverage.mjs.
 *
 * The gate reports "nothing is missing". That sentence is true of a table with
 * nothing missing and equally true of an extractor that found nothing, so every
 * way it could go false-green is an executable case here: each of its four
 * extractors broken to return the empty set, an arm deleted, and an arm's key
 * misspelt the way the real one was (#3172).
 *
 * Method matches scripts/check-clash-degenerate-reason-parity.test.mjs: mutate
 * a copy of the REAL sources in a temp tree outside the repo, run the
 * UNMODIFIED checker against it via `--root`, and assert exit code plus
 * message. Every mutation anchor is asserted to exist in the real input first,
 * so a drifted anchor fails the suite instead of quietly testing nothing.
 *
 * Run: node --test scripts/check-legacy-entity-coverage.test.mjs
 * (wired as a step of the CI node-test job in .github/workflows/test.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyKeys, generatedNames, parseEntityTable, droppableProducts } from './check-legacy-entity-coverage.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const CHECKER = join(SCRIPTS, 'check-legacy-entity-coverage.mjs');

const LEGACY_REL = 'rust/core/src/legacy_entities.rs';
const SCHEMA_REL = 'rust/core/src/generated/schema.rs';
const DATA_DIR = 'packages/data/src/ifc-schema/generated';
const TABLE_RELS = ['entities-ifc2x3.ts', 'entities-ifc4.ts', 'entities-ifc4x3.ts'].map((f) =>
  join(DATA_DIR, f),
);

const real = new Map([[LEGACY_REL, null], [SCHEMA_REL, null], ...TABLE_RELS.map((r) => [r, null])]);
for (const rel of [...real.keys()]) real.set(rel, readFileSync(join(ROOT, rel), 'utf8'));

/** Writes a (possibly mutated) tree to a temp dir and runs the checker on it. */
function runOn(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-entity-coverage-'));
  try {
    for (const [rel, content] of real) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, overrides[rel] ?? content);
    }
    const r = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the real tree passes', () => {
  const { status, out } = runOn();
  assert.equal(status, 0, out);
  assert.match(out, /check-legacy-entity-coverage: OK/);
});

test('the extractors are not vacuous on the real tree', () => {
  // Each number the gate's verdict depends on, asserted non-trivial here so a
  // regenerated table that silently changes shape fails loudly rather than
  // reducing the gate to zero comparisons.
  assert.ok(legacyKeys(real.get(LEGACY_REL)).size >= 20);
  assert.ok(generatedNames(real.get(SCHEMA_REL)).size >= 500);
  const tables = TABLE_RELS.slice(0, 2).map((rel) => ({
    schema: rel,
    table: parseEntityTable(real.get(rel)),
  }));
  assert.ok(droppableProducts(tables).size >= 100);
});

test('an arm deleted from the table is reported', () => {
  const anchor = '"IFCELECTRICALELEMENT" => Some(LegacyEntityInfo {\n            base_type: IfcType::IfcElement,\n            has_geometry: true,\n        }),';
  assert.ok(real.get(LEGACY_REL).includes(anchor), 'mutation anchor drifted');
  const { status, out } = runOn({ [LEGACY_REL]: real.get(LEGACY_REL).replace(anchor, '') });
  assert.equal(status, 1, out);
  assert.match(out, /IfcElectricalElement .*has no arm in/);
});

test("an arm whose key names no entity is reported — the #3172 misspelling", () => {
  const anchor = '"IFCELECTRICDISTRIBUTIONPOINT"';
  assert.ok(real.get(LEGACY_REL).includes(anchor), 'mutation anchor drifted');
  const { status, out } = runOn({
    [LEGACY_REL]: real.get(LEGACY_REL).replace(anchor, '"IFCELECTRICALDISTRIBUTIONPOINT"'),
  });
  assert.equal(status, 1, out);
  // Both halves must fire: the key names nothing, AND the entity it was meant
  // to cover is now uncovered. Reporting only one would let a respelling that
  // moved the arm to another dead name look like a single fixable typo.
  assert.match(out, /names no entity in any bundled schema table/);
  assert.match(out, /IfcElectricDistributionPoint .*has no arm in/);
});

test('a match arm absent from LEGACY_ENTITY_NAMES is reported', () => {
  // The const is public and feeds the cross-language rooted-type universe
  // (dump_rooted_type_sweep.rs), so an arm that never reaches it makes that
  // sweep structurally blind to the name -- which is how the three stratum
  // leaves stayed divergent with both halves of that gate green (#3124 review).
  const real = readFileSync(join(ROOT, LEGACY_REL), 'utf8');
  const i = real.indexOf('pub const LEGACY_ENTITY_NAMES');
  assert.notEqual(i, -1, 'const anchor drifted');
  const target = '"IFCPRESENTATIONSTYLEASSIGNMENT",';
  const j = real.indexOf(target, i);
  assert.notEqual(j, -1, 'mutation anchor drifted');
  const { status, out } = runOn({ [LEGACY_REL]: real.slice(0, j) + real.slice(j + target.length) });
  assert.equal(status, 1, out);
  assert.match(out, /match arms absent from LEGACY_ENTITY_NAMES.*IFCPRESENTATIONSTYLEASSIGNMENT/);
});

test('a LEGACY_ENTITY_NAMES entry with no match arm is reported', () => {
  // The other direction. A name in the const that no arm produces would put a
  // phantom into the sweep's universe and read as a real legacy entity.
  const real = readFileSync(join(ROOT, LEGACY_REL), 'utf8');
  const i = real.indexOf('pub const LEGACY_ENTITY_NAMES');
  const j = real.indexOf('[', i) + 1;
  const { status, out } = runOn({ [LEGACY_REL]: real.slice(0, j) + '\n    "IFCPHANTOMENTITY",' + real.slice(j) });
  assert.equal(status, 1, out);
  assert.match(out, /IFCPHANTOMENTITY, which is not a match arm/);
});

test('a broken LEGACY_ENTITY_NAMES extractor fails instead of passing vacuously', () => {
  // Two empty sets agree about everything. If the const is renamed or the
  // block shape changes, this must fail rather than silently compare nothing.
  const real = readFileSync(join(ROOT, LEGACY_REL), 'utf8');
  const { status, out } = runOn({
    [LEGACY_REL]: real.replace('pub const LEGACY_ENTITY_NAMES', 'pub const RENAMED_CONST'),
  });
  assert.equal(status, 1, out);
  assert.match(out, /no names extracted from LEGACY_ENTITY_NAMES/);
});

test('a broken legacy-arm extractor fails instead of passing vacuously', () => {
  const { status, out } = runOn({ [LEGACY_REL]: '// every arm gone\n' });
  assert.equal(status, 1, out);
  assert.match(out, /no arms extracted from/);
});

test('a broken generated-schema extractor fails instead of passing vacuously', () => {
  const { status, out } = runOn({ [SCHEMA_REL]: 'pub fn from_str() {}\n' });
  assert.equal(status, 1, out);
  assert.match(out, /names extracted from .*from_str/);
});

test('a broken entity-table extractor fails instead of passing vacuously', () => {
  const overrides = {};
  for (const rel of TABLE_RELS) overrides[rel] = 'export const ENTITIES = [];\n';
  const { status, out } = runOn(overrides);
  assert.equal(status, 1, out);
  assert.match(out, /no concrete products extracted from/);
});

test('emptying ONE table is caught, including the one the union would hide', () => {
  // The dead-key half reads the UNION of the three tables, which IFC2X3 and
  // IFC4 dominate: a broken IFC4X3 extractor leaves that union at ~1700 names
  // and clears any union-wide floor while the table that vouches for an
  // IFC4X3-only name is gone. Each table is therefore sized on its own, and
  // this asserts that for every one of the three -- the union floor version of
  // this guard passed the IFC4X3 case, which is why it is sized per table.
  for (const rel of TABLE_RELS) {
    const { status, out } = runOn({ [rel]: 'export const ENTITIES = [];\n' });
    assert.equal(status, 1, `${rel} emptied but the gate stayed green:\n${out}`);
    assert.match(out, new RegExp(`entities extracted from ${rel.split('/').pop()}`));
  }
});
