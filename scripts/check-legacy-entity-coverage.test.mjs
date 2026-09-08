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
  assert.doesNotMatch(out, /NO REMEDY MATCHED/);
    // Pins the add-an-arm remedy TEXT. A deleted block or a drifted dispatch
    // key is already covered by doesNotMatch(/NO REMEDY MATCHED/) -- killing
    // the key reddens this test's own line 89 plus one other test, 14/16.
    // What ONLY this line catches is the remedy text changing while its key
    // stays intact: 15/16, and nothing else observes it.
  assert.match(out, /Add an arm mapping each name/);
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
  assert.doesNotMatch(out, /NO REMEDY MATCHED/);
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

test('a failure with no remedy is reported as a defect in this script', () => {
  // The guard that catches an unrouted message needs its own test, or it is a
  // guard that cannot catch its own regression -- which is what it exists to
  // prevent. `runOn` overrides SOURCE files and runs the real checker, so it
  // cannot inject a message; this mutates a copy of the checker instead.
  const src = readFileSync(CHECKER, 'utf8');
  const anchor = '  if (failures.length > 0) return failures;';
  assert.ok(src.includes(anchor), 'checker mutation anchor drifted');
  const dir = mkdtempSync(join(tmpdir(), 'legacy-unrouted-'));
  try {
    // The name matters: the checker's main-entry guard is
    // `process.argv[1].endsWith('check-legacy-entity-coverage.mjs')`, so a copy
    // under any other name loads, does nothing, and exits 0 -- which would make
    // this test pass for the wrong reason if it asserted only on the output.
    const mutated = join(dir, 'check-legacy-entity-coverage.mjs');
    writeFileSync(
      mutated,
      src.replace(
        anchor,
        "  failures.push('first class with no remedy block');\n" +
          "  failures.push('second class with no remedy block');\n" +
          anchor,
      ),
    );
    const r = spawnSync(process.execPath, [mutated, '--root', ROOT], { encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, out);
    assert.match(out, /NO REMEDY MATCHED/);
      // Assert on the GUARD's block only. The failure list above it prints one
      // console.error per failure, so a regex run against the whole output
      // matches those lines and passes whatever the guard's own separator does
      // -- which is how the first version of this assertion passed with the
      // separator broken.
      const guardBlock = out.slice(out.indexOf('NO REMEDY MATCHED'));
      // TWO, not one: a single injected failure never exercises `join`, and a
      // re-embed that turned the separator into a literal backslash-n printed
      // both names on one run-on line.
      assert.match(guardBlock, /\n {2}first class with no remedy block\n {2}second class with no remedy block\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a const/arm mismatch gets a remedy, not a bare failure line', () => {
  // #3204's two LEGACY_ENTITY_NAMES messages arrived in this gate from another
  // PR. On main there was no dispatch at all -- one unconditional epilogue --
  // so they printed the add-an-arm advice: fix an arm, when the arm exists and
  // the const is what is missing. Contradictory, not absent.
  const real = readFileSync(join(ROOT, LEGACY_REL), 'utf8');
  const t = '"IFCPRESENTATIONSTYLEASSIGNMENT",';
  const j = real.indexOf(t, real.indexOf('pub const LEGACY_ENTITY_NAMES'));
  assert.notEqual(j, -1, 'mutation anchor drifted');
  const { status, out } = runOn({ [LEGACY_REL]: real.slice(0, j) + real.slice(j + t.length) });
  assert.equal(status, 1, out);
  assert.match(out, /match arms absent from LEGACY_ENTITY_NAMES/);
  assert.match(out, /feeds the cross-language rooted-type sweep/);
  assert.doesNotMatch(out, /Add an arm mapping each name/);
  assert.doesNotMatch(out, /NO REMEDY MATCHED/);
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
  // The const-mirror remedy must NOT print here. All 26 names ARE in the const;
  // the extractor could not find the block, so there is nothing to add or
  // delete. A bare `LEGACY_ENTITY_NAMES` dispatch key matched this message and
  // printed that advice -- the absence of this assertion is why it was green.
  assert.doesNotMatch(out, /Add the missing name to the const/);
  assert.doesNotMatch(out, /NO REMEDY MATCHED/);
});

test('an arm whose key from_str already resolves is reported', () => {
  // The invariant `legacy_aware_ifc_type_from_record`'s Unknown short-circuit
  // rests on: no key in the table may be a name the generated enum knows. If
  // one is, the short-circuit fires and the remap is silently skipped.
  //
  // `IFCWALL` is the mutation because it is unambiguously in `from_str` today,
  // so the case cannot rot into a no-op the way a borderline name could.
  const anchor = '"IFCPRESENTATIONSTYLEASSIGNMENT"';
  assert.ok(real.get(LEGACY_REL).includes(anchor), 'mutation anchor drifted');
  const { status, out } = runOn({
    [LEGACY_REL]: real.get(LEGACY_REL).replace(anchor, '"IFCWALL"'),
  });
  assert.equal(status, 1, out);
  assert.match(out, /has an arm for "IFCWALL", which .*from_str already resolves/);
  assert.doesNotMatch(out, /NO REMEDY MATCHED/);
  // The remedy has to match the failure. This class needs the arm REMOVED; the
  // add-an-arm epilogue would send the reader the opposite way, and a gate whose
  // instructions contradict its own finding is worse than one that says nothing.
  assert.match(out, /REMOVE the arm/);
  assert.doesNotMatch(out, /Add an arm mapping each name/);
});

test('a dead key gets the respell remedy, NOT the add-an-arm one', () => {
  // The split that introduced per-class remedies routed this class to the
  // add-an-arm text, which says to add something when the arm already exists.
  // It looked complete because the #3172 case fires BOTH classes at once and
  // add-an-arm happens to be right for the other half. Reached here by adding
  // an arm that fires the dead-key class ALONE.
  // ADDS an arm rather than renaming one: renaming deletes a real key too, which
  // fires the missing-arm class as well and lets add-an-arm appear legitimately.
  // That is exactly how the first version of this test passed for the wrong
  // reason -- it failed, and the failure is what showed the mutation was wrong.
  const anchor = '"IFCPROXY" => Some(LegacyEntityInfo {';
  assert.ok(real.get(LEGACY_REL).includes(anchor), 'mutation anchor drifted');
  const extra =
    '"IFCTYPOEDWIDGET" => Some(LegacyEntityInfo {\n' +
    '            base_type: IfcType::IfcBuildingElementProxy,\n' +
    '            has_geometry: true,\n' +
    '        }),\n        ' +
    anchor;
  const { status, out } = runOn({
    [LEGACY_REL]: real.get(LEGACY_REL).replace(anchor, extra),
  });
  assert.equal(status, 1, out);
  assert.match(out, /names no entity in any bundled schema table/);
  assert.match(out, /Check the spelling against the bundled tables first/);
  assert.doesNotMatch(out, /Add an arm mapping each name/);
});

// One fixture, two tests. Emptying the arm table drives BOTH the vacuity
// failure and the neutral-header/remedy behaviour, and two copies of the
// literal could drift apart silently while both stayed green. The literal is
// shared, not the run: each test still calls `runOn` next to its own
// assertions, as the other `runOn` tests here do, and nothing spawns at
// import time.
const ARMS_GONE_TREE = { [LEGACY_REL]: '// every arm gone\n' };

test('extractor drift blames neither side until the cause is known', () => {
  const { status, out } = runOn(ARMS_GONE_TREE);
  assert.equal(status, 1, out);
  // The table may be perfectly correct, so "out of step" would send the reader
  // to edit the wrong file.
  assert.match(out, /these inputs did not read as expected/);
  assert.doesNotMatch(out, /is out of step with the bundled schema tables/);
  // ...and it must not blame the extractor either. THIS FIXTURE is the proof:
  // it empties the input and leaves every regex untouched, so the message it
  // produces is the one an input-side defect produces. Two earlier versions of
  // this block picked a side -- first the extractor, then the extractor "for
  // the zero-count cases" -- and this same fixture refutes both.
  assert.match(out, /none of these checks can tell/);
  assert.match(out, /input genuinely shrank and the regexes are fine/);
  assert.doesNotMatch(out, /certainly the extractor/);
  assert.doesNotMatch(out, /Add an arm mapping each name/);
});

test('a broken legacy-arm extractor fails instead of passing vacuously', () => {
  const { status, out } = runOn(ARMS_GONE_TREE);
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
