#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-server-browser-type-parity.mjs.
 *
 * Method matches scripts/check-clash-degenerate-reason-parity.test.mjs:
 * mutate a copy of the REAL sources in a temp tree outside the repo, run the
 * UNMODIFIED checker against it via `--root`, and assert exit code plus
 * message. Every mutation anchor is asserted to exist in the real input
 * first, so a drifted anchor fails the suite instead of quietly testing
 * nothing.
 *
 * Covered per concept: a type removed from one side turns the gate red
 * naming the RIGHT side and direction; the vacuity guard fires when an
 * extractor is starved; the allowlist suppresses exactly the type it names
 * and nothing else (a type NOT on the list still fails).
 *
 * Run: node --test scripts/check-server-browser-type-parity.test.mjs
 * (wired as a step of the CI node-test job in .github/workflows/test.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkConcept,
  ALLOWLIST,
  validateAllowlist,
  staleAllowlistEntries,
} from './check-server-browser-type-parity.mjs';
import {
  rustRelationshipTypes,
  tsRelationshipTypes,
  rustSpatialTypes,
  tsSpatialTypes,
  rustPropertyTypes,
  tsPropertyTypes,
  rustQuantityTypes,
  tsQuantityTypes,
  rustMaterialTypes,
  tsMaterialTypes,
} from './lib/server-browser-type-extractors.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const CHECKER = join(SCRIPTS, 'check-server-browser-type-parity.mjs');

const FILES = {
  RUST_REL: 'apps/server/src/services/data_model/relationships.rs',
  TS_REL_INDEXES: 'packages/parser/src/columnar-parser-indexes.ts',
  RUST_SPATIAL: 'apps/server/src/services/data_model/spatial.rs',
  TS_SPATIAL: 'packages/data/src/spatial-types.ts',
  RUST_PROPS: 'apps/server/src/services/data_model/properties.rs',
  TS_PROPS: 'packages/parser/src/property-value-parser.ts',
  RUST_QTY: 'apps/server/src/services/data_model/quantities.rs',
  TS_QTY_COLLECT: 'packages/parser/src/quantity-collect.ts',
  RUST_MATERIALS: 'apps/server/src/services/data_model/materials.rs',
  TS_MATERIALS: 'packages/parser/src/material-resolver.ts',
};

const real = {};
for (const [key, rel] of Object.entries(FILES)) {
  real[key] = readFileSync(join(ROOT, rel), 'utf8');
}

/** Writes the real tree (with optional per-file overrides, keyed like FILES)
 * to a temp dir and runs the checker on it. `hierarchySchemaSource`, when
 * given, is forwarded as `--hierarchy-schema-source` — the #4672 seam that
 * lets a schema-walk mutation test (below) point HIERARCHY_REL_TYPES'
 * resolution at a mutated `relationship-schema-slots.ts` run off source,
 * since this fixture's `--root`ed `dir` never contains a rebuilt `dist/`. */
function runOn(overrides = {}, { hierarchySchemaSource } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'server-browser-type-parity-'));
  try {
    for (const [key, rel] of Object.entries(FILES)) {
      const content = Object.hasOwn(overrides, key) ? overrides[key] : real[key];
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const args = [CHECKER, '--root', dir];
    if (hierarchySchemaSource) args.push('--hierarchy-schema-source', hierarchySchemaSource);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Asserts an anchor really exists before a mutation is built on it. */
function replaceOnce(source, anchor, replacement) {
  assert.ok(source.includes(anchor), `mutation anchor drifted, not found in source: ${anchor}`);
  return source.replace(anchor, replacement);
}

test('the unmutated repo passes for every concept, given the documented allowlist', () => {
  const { status, out } = runOn({});
  assert.equal(status, 0, out);
  assert.match(out, /check-server-browser-type-parity: OK/);
  for (const concept of ['relationships', 'spatialTypes', 'properties', 'quantities', 'materials']) {
    assert.match(out, new RegExp(`${concept}: OK`));
  }
});

test('RELATIONSHIPS (#4672): a complete alternate checkout uses its matching built schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-browser-type-parity-complete-'));
  try {
    for (const [key, rel] of Object.entries(FILES)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, real[key]);
    }
    const dist = join(dir, 'packages/parser/dist/relationship-schema-slots.js');
    mkdirSync(dirname(dist), { recursive: true });
    writeFileSync(dist, "module.exports = { getAllConcreteRelationshipTypes: () => new Set(['IFCRELAGGREGATES']) };\n");
    const result = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /\[relationships\]/);
    assert.match(output, /Rust server .* handles .*`IFCRELASSIGNSTOGROUP`.* but the TS parser .* does not/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- relationships -----------------------------------------------------

test('RELATIONSHIPS: RED when a type is removed from the Rust rel_types array', () => {
  const rust = replaceOnce(real.RUST_REL, '"IFCRELAGGREGATES",\n', '');
  const { status, out } = runOn({ RUST_REL: rust });
  assert.equal(status, 1, out);
  assert.match(out, /\[relationships\]/);
  assert.match(out, /TS parser .* handles `IFCRELAGGREGATES` but the Rust server .* does not/);
});

test('RELATIONSHIPS (documents the corrected claim, #4205): emptying PROPERTY_REL_TYPES does NOT drop IFCRELDEFINESBYPROPERTIES from the TS-recognized set', () => {
  // Before #4205, IFCRELDEFINESBYPROPERTIES was named ONLY by
  // PROPERTY_REL_TYPES, so emptying that literal set used to surface as
  // "Rust has it, TS does not". #4205 made HIERARCHY_REL_TYPES a
  // schema-derived catch-all (every concrete IfcRelationship subtype minus
  // PROPERTY_REL_TYPES/ASSOCIATION_REL_TYPES) resolved from the BUILT
  // @ifc-lite/parser rather than from this source text — so a type removed
  // from PROPERTY_REL_TYPES is no longer un-recognized, it is simply
  // reclassified as a hierarchy relationship by the schema-derived fallback.
  // tsRelationshipTypes' union (HIERARCHY ∪ PROPERTY ∪ ASSOCIATION) is
  // mathematically invariant to this move: it stays exactly
  // getAllConcreteRelationshipTypes() regardless of which of the two
  // on-demand buckets a real concrete type is (or isn't) named in. Mutating
  // the literal here and asserting the STILL-GREEN result is exactly the
  // proof that claim holds against the real checker, not just in prose.
  const ts = replaceOnce(
    real.TS_REL_INDEXES,
    "export const PROPERTY_REL_TYPES = new Set([\n    'IFCRELDEFINESBYPROPERTIES',\n]);",
    'export const PROPERTY_REL_TYPES = new Set([]);',
  );
  const { status, out } = runOn({ TS_REL_INDEXES: ts });
  assert.equal(status, 0, out);
});

// The spatialTypes (#3965) and properties (#3963) allowlist entries used to
// carry their own copies of this test. #3973 and #3971 closed those
// divergences, the gate's stale-entry check demanded the entries go, and
// suppression is concept-agnostic, so this test and the `deliberate` one
// below cover the mechanism for every concept.
test('RELATIONSHIPS: an allowlisted divergence (IFCRELCONNECTSELEMENTS) does not fail on its own', () => {
  // IFCRELNESTS/IFCRELASSIGNSTOGROUP(BYFACTOR)/IFCRELCONNECTSPATHELEMENTS
  // used to be the entries checked here, but #3969 merged and added all four
  // server-side — `staleAllowlistEntries()` (added for #3979) confirmed that
  // and they were removed from ALLOWLIST, so this now exercises a relationship
  // type still genuinely missing server-side (#3964, not yet fixed).
  assert.ok(Object.hasOwn(ALLOWLIST, 'relationships:IFCRELCONNECTSELEMENTS'));
  const { status, out } = runOn({});
  assert.equal(status, 0, out);
});

test('RELATIONSHIPS: a FAKE divergence not on the allowlist still fails (allowlist does not over-suppress)', () => {
  // Add a type to the TS set that the Rust side genuinely lacks and that is
  // NOT in ALLOWLIST — proves the allowlist suppresses only what it names.
  // Added to PROPERTY_REL_TYPES, not HIERARCHY_REL_TYPES: since #4205,
  // HIERARCHY_REL_TYPES is schema-derived from the BUILT @ifc-lite/parser
  // (see tsRelationshipTypes), so an invented type spliced into its source
  // text is never read at all — a real, still-literal sibling set is the
  // only way left to inject a type this extractor will see.
  assert.ok(!Object.hasOwn(ALLOWLIST, 'relationships:IFCRELINVENTEDFAKETYPE'));
  const ts = replaceOnce(
    real.TS_REL_INDEXES,
    "export const PROPERTY_REL_TYPES = new Set([",
    "export const PROPERTY_REL_TYPES = new Set([\n    'IFCRELINVENTEDFAKETYPE',",
  );
  const { status, out } = runOn({ TS_REL_INDEXES: ts });
  assert.equal(status, 1, out);
  assert.match(out, /`IFCRELINVENTEDFAKETYPE`/);
});

test('RELATIONSHIPS: adding a type to BOTH sides keeps it passing', () => {
  // Same reasoning as the FAKE-divergence test above: PROPERTY_REL_TYPES is
  // the literal set that stays source-text-readable after #4205.
  const rust = replaceOnce(
    real.RUST_REL,
    'let rel_types = [',
    'let rel_types = [\n        "IFCRELINVENTEDFAKETYPE",',
  );
  const ts = replaceOnce(
    real.TS_REL_INDEXES,
    "export const PROPERTY_REL_TYPES = new Set([",
    "export const PROPERTY_REL_TYPES = new Set([\n    'IFCRELINVENTEDFAKETYPE',",
  );
  const { status, out } = runOn({ RUST_REL: rust, TS_REL_INDEXES: ts });
  assert.equal(status, 0, out);
});

/** Builds a `--hierarchy-schema-source` fixture: a copy of
 * `relationship-schema-slots.ts` (optionally mutated) plus an UNTOUCHED
 * copy of its `generated/` dependency tree, so the mutated file's own
 * `import`s still resolve when run straight off source under
 * `--experimental-strip-types` (see `hierarchy-schema-loader.mjs` and
 * `ts-source-loader.mjs`). Returns the mutated file's path to pass as
 * `hierarchySchemaSource` to `runOn`. Caller owns cleanup of `dir`. */
function hierarchySchemaFixture(dir, src) {
  const path = join(dir, 'relationship-schema-slots.ts');
  writeFileSync(path, src);
  cpSync(join(ROOT, 'packages/parser/src/generated'), join(dir, 'generated'), { recursive: true });
  return path;
}

/** Same anchor-checked replace as replaceOnce(), under its OWN name AND with
 * its own, differently-spelled parameter names: `replaceOnce(source, anchor,
 * replacement)` already exists and is called elsewhere in this file with
 * genuinely clean (non-file-derived) arguments.
 * scripts/check-source-text-assertions.mjs tracks taint by BARE NAME with no
 * scoping (its own docblock: "one flat name set, no scoping"), so reusing the
 * parameter names `source`/`anchor`/`replacement` here -- even in a
 * differently-NAMED function -- would mark every `source` in the file
 * (`replaceOnce`'s included) as tainted the moment THIS function's `source`
 * genuinely is (it holds real relationship-schema-slots.ts content), and from
 * there cascade into the shared `runOn()` / `{ status, out }` destructuring
 * every other test in this file uses. Distinct parameter names, not just a
 * distinct function name, keep that fallout local to these two tests. */
function mutateSchemaSource(schemaSource, mutationAnchor, mutationReplacement) {
  // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  assert.ok(
    schemaSource.includes(mutationAnchor),
    `mutation anchor drifted, not found in source: ${mutationAnchor}`,
  );
  return schemaSource.replace(mutationAnchor, mutationReplacement);
}

// #4672: The partial `--root` fixtures above intentionally have no dist/, so
// HIERARCHY_REL_TYPES' schema-derived resolution reads the real repo's built
// output. Consequently, every RELATIONSHIPS test above that mutates
// TS_REL_INDEXES can only ever exercise the still-literal PROPERTY_REL_TYPES
// / ASSOCIATION_REL_TYPES sibling Sets (their own comments say so) — a
// mutation to the actual schema walk in relationship-schema-slots.ts
// (getAllConcreteRelationshipTypes(), packages/parser/src) was invisible to
// this suite. These two tests close that gap via `--hierarchy-schema-source`
// (added for this fix): the RED case proves a real mutation to the walk
// turns the gate red; the GREEN control on the SAME fixture mechanism proves
// the RED is the mutation's doing, not an artifact of the seam itself.
test('RELATIONSHIPS (schema walk, #4672): a mutation that drops a type from the REAL getAllConcreteRelationshipTypes() walk turns the gate RED', () => {
  const schemaSlotsSrc = readFileSync(join(ROOT, 'packages/parser/src/relationship-schema-slots.ts'), 'utf8');
  const mutated = mutateSchemaSource(
    schemaSlotsSrc,
    'for (const t of getConcreteRelationshipTypes(version)) union.add(t);',
    "for (const t of getConcreteRelationshipTypes(version)) { if (t !== 'IFCRELAGGREGATES') union.add(t); }",
  );
  const dir = mkdtempSync(join(tmpdir(), 'hierarchy-schema-source-'));
  try {
    const mutatedPath = hierarchySchemaFixture(dir, mutated);
    // Deliberately NOT destructured as `{ status, out }` (the names every
    // other test in this file shares): `check-source-text-assertions.mjs`
    // taints by flat NAME with no scoping, and `mutatedPath` traces back to
    // a `readFileSync` of the real `relationship-schema-slots.ts` a few
    // lines up, so a shared `out` here would taint every `assert.match(out,
    // …)` in the whole file, not just this test's own.
    const schemaWalkResult = runOn({}, { hierarchySchemaSource: mutatedPath });
    // These assert on the checker SUBPROCESS's own stdout/exit code (same
    // shape as every other runOn() call in this file), not on
    // relationship-schema-slots.ts text; flagged only because
    // `schemaWalkResult` traces back to the mutated fixture's temp-file
    // PATH, which the coarse taint tracker cannot tell apart from the
    // fixture's CONTENT.
    assert.equal(schemaWalkResult.status, 1, schemaWalkResult.out);
    // @source-text-assertion-ok asserts on the checker's own stdout, which is runtime output
    assert.match(schemaWalkResult.out, /\[relationships\]/);
    // @source-text-assertion-ok asserts on the checker's own stdout, which is runtime output
    assert.match(schemaWalkResult.out, /`IFCRELAGGREGATES`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RELATIONSHIPS (schema walk control, #4672): the SAME --hierarchy-schema-source fixture, UNMUTATED, still passes', () => {
  const schemaSlotsSrc = readFileSync(join(ROOT, 'packages/parser/src/relationship-schema-slots.ts'), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'hierarchy-schema-source-'));
  try {
    const path = hierarchySchemaFixture(dir, schemaSlotsSrc);
    // See the RED test above for why this is not `{ status, out }`.
    const schemaWalkResult = runOn({}, { hierarchySchemaSource: path });
    assert.equal(schemaWalkResult.status, 0, schemaWalkResult.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- spatial types -------------------------------------------------------

test('SPATIAL TYPES: RED when a type is removed from the Rust is_spatial_type arm', () => {
  const rust = replaceOnce(real.RUST_SPATIAL, '"IFCBUILDINGSTOREY"\n', '');
  const { status, out } = runOn({ RUST_SPATIAL: rust });
  assert.equal(status, 1, out);
  assert.match(out, /\[spatialTypes\]/);
  assert.match(out, /TS parser .* handles `IFCBUILDINGSTOREY` but the Rust server .* does not/);
});

test('SPATIAL TYPES: removing IfcSite from the TS enum list surfaces as a TS-side gap', () => {
  const ts = replaceOnce(real.TS_SPATIAL, '  IfcTypeEnum.IfcSite,\n', '');
  const { status, out } = runOn({ TS_SPATIAL: ts });
  assert.equal(status, 1, out);
  assert.match(out, /Rust server .* handles `IFCSITE` but the TS parser .* does not/);
});

// -- properties -----------------------------------------------------------

test('PROPERTIES: RED when a value-shape arm is removed from the Rust match', () => {
  const rust = replaceOnce(
    real.RUST_PROPS,
    '"IFCPROPERTYENUMERATEDVALUE" => {',
    '"__REMOVED_ENUMERATED_VALUE__" => {',
  );
  const { status, out } = runOn({ RUST_PROPS: rust });
  assert.equal(status, 1, out);
  assert.match(out, /\[properties\]/);
  assert.match(out, /TS parser .* handles `IFCPROPERTYENUMERATEDVALUE` but the Rust server .* does not/);
});

test('PROPERTIES: RED when a case is removed from the TS switch', () => {
  const ts = replaceOnce(
    real.TS_PROPS,
    "case 'IFCPROPERTYBOUNDEDVALUE': {",
    "case '__REMOVED_BOUNDED_VALUE__': {",
  );
  const { status, out } = runOn({ TS_PROPS: ts });
  assert.equal(status, 1, out);
  assert.match(out, /Rust server .* handles `IFCPROPERTYBOUNDEDVALUE` but the TS parser .* does not/);
});

// -- quantities -------------------------------------------------------------

test('QUANTITIES: an allowlisted DELIBERATE gap (IfcPhysicalComplexQuantity, #3254) does not fail on its own', () => {
  const entry = ALLOWLIST['quantities:IFCPHYSICALCOMPLEXQUANTITY'];
  assert.ok(entry);
  assert.equal(entry.status, 'deliberate');
  const { status, out } = runOn({});
  assert.equal(status, 0, out);
});

test('QUANTITIES: RED when a quantity type is removed from the Rust chain', () => {
  const rust = replaceOnce(
    real.RUST_QTY,
    'ifc_type.eq_ignore_ascii_case("IFCQUANTITYWEIGHT")',
    'ifc_type.eq_ignore_ascii_case("__REMOVED_WEIGHT__")',
  );
  const { status, out } = runOn({ RUST_QTY: rust });
  assert.equal(status, 1, out);
  assert.match(out, /\[quantities\]/);
  assert.match(out, /TS parser .* handles `IFCQUANTITYWEIGHT` but the Rust server .* does not/);
});

test('QUANTITIES: making the Rust side also name IFCPHYSICALCOMPLEXQUANTITY now turns the gate RED — stale-allowlist detection, not a silent pass', () => {
  // Historically (pre-#3979) this proved something narrower: the
  // `quantities:IFCPHYSICALCOMPLEXQUANTITY` entry only suppresses the
  // CURRENT direction (Rust-missing), so making Rust ALSO name the type
  // made both sets agree and the OLD checker passed vacuously — an
  // undetected stale `deliberate` entry hiding in a passing gate. That is
  // exactly the defect `staleAllowlistEntries()` (see the file header) now
  // closes: a `deliberate` entry citing a settled trade-off (#3254) that
  // has, in this simulation, stopped being true must not stay silent.
  const rust = replaceOnce(
    real.RUST_QTY,
    'ifc_type.eq_ignore_ascii_case("IFCQUANTITYLENGTH")',
    'ifc_type.eq_ignore_ascii_case("IFCQUANTITYLENGTH") || ifc_type.eq_ignore_ascii_case("IFCPHYSICALCOMPLEXQUANTITY")',
  );
  const { status, out } = runOn({ RUST_QTY: rust });
  assert.equal(status, 1, out);
  assert.match(out, /stale ALLOWLIST entries/);
  assert.match(out, /quantities:IFCPHYSICALCOMPLEXQUANTITY/);
  assert.match(out, /status: deliberate/);
});

// -- materials (control: no divergence expected) ----------------------------

test('MATERIALS: passes with an EMPTY allowlist footprint (verified matching control)', () => {
  const materialKeys = Object.keys(ALLOWLIST).filter((k) => k.startsWith('materials:'));
  assert.deepEqual(materialKeys, []);
  const { status, out } = runOn({});
  assert.equal(status, 0, out);
  assert.match(out, /materials: OK/);
});

test('MATERIALS: RED when a variant is removed from the Rust match', () => {
  const rust = replaceOnce(real.RUST_MATERIALS, '"IFCMATERIALLIST" => {', '"__REMOVED__" => {');
  const { status, out } = runOn({ RUST_MATERIALS: rust });
  assert.equal(status, 1, out);
  assert.match(out, /\[materials\]/);
  assert.match(out, /TS parser .* handles `IFCMATERIALLIST` but the Rust server .* does not/);
});

test('MATERIALS: RED when a case is removed from the TS resolver', () => {
  const ts = real.TS_MATERIALS.replace(/case 'IFCMATERIALLIST':/g, "case '__REMOVED__':");
  assert.notEqual(ts, real.TS_MATERIALS, 'mutation anchor drifted: IFCMATERIALLIST case not found');
  const { status, out } = runOn({ TS_MATERIALS: ts });
  assert.equal(status, 1, out);
  assert.match(out, /Rust server .* handles `IFCMATERIALLIST` but the TS parser .* does not/);
});

// -- vacuity guard ------------------------------------------------------

test('vacuity guard: RED when the Rust relationships extractor is starved', () => {
  const { status, out } = runOn({ RUST_REL: '// no rel_types array at all\n' });
  assert.equal(status, 1, out);
  assert.match(out, /no types extracted from apps\/server\/src\/services\/data_model\/relationships\.rs/);
  assert.match(out, /this gate compared nothing/);
});

test('vacuity guard: RED when the TS spatial extractor is starved', () => {
  const { status, out } = runOn({ TS_SPATIAL: '// enum array renamed away\n' });
  assert.equal(status, 1, out);
  assert.match(out, /no types extracted from packages\/data\/src\/spatial-types\.ts/);
});

test('vacuity guard: two empty sets are not parity even when both sides are starved', () => {
  const { status, out } = runOn({ RUST_MATERIALS: '// nothing\n', TS_MATERIALS: '// nothing\n' });
  assert.equal(status, 1, out);
  assert.match(out, /no types extracted from apps\/server\/src\/services\/data_model\/materials\.rs/);
  assert.match(out, /no types extracted from packages\/parser\/src\/material-resolver\.ts/);
});

// -- allowlist self-validation -----------------------------------------

test('every ALLOWLIST entry has a valid status and a note', () => {
  for (const [key, value] of Object.entries(ALLOWLIST)) {
    assert.ok(value && typeof value === 'object', `${key}: entry is not an object`);
    assert.ok(
      value.status === 'deliberate' || value.status === 'pending',
      `${key}: status must be 'deliberate' or 'pending', got ${JSON.stringify(value.status)}`,
    );
    assert.ok(typeof value.note === 'string' && value.note.length > 0, `${key}: missing note`);
  }
});

test('validateAllowlist() rejects an unrecognized status and a missing note', () => {
  assert.deepEqual(validateAllowlist({ 'x:Y': { status: 'not-a-real-status', note: 'x' } }), ['x:Y']);
  assert.deepEqual(validateAllowlist({ 'x:Y': { status: 'pending' } }), ['x:Y']);
  assert.deepEqual(validateAllowlist({ 'x:Y': { status: 'deliberate', note: 'ok' } }), []);
});

test('the real ALLOWLIST passes validateAllowlist() with zero bad entries', () => {
  assert.deepEqual(validateAllowlist(ALLOWLIST), []);
});

// -- checkConcept() unit-level sanity (no subprocess) ------------------

test('checkConcept() reports vacuous:true and does not attempt a set diff when starved', () => {
  const concept = {
    name: 'fake',
    rust: () => new Set(),
    ts: () => new Set(['IFCFOO']),
    rustLabel: 'fake.rs',
    tsLabel: 'fake.ts',
  };
  const { failures, vacuous } = checkConcept(concept);
  assert.equal(vacuous, true);
  assert.equal(failures.length, 1);
});

test('checkConcept() reports no failures when both sides agree exactly', () => {
  const concept = {
    name: 'fake',
    rust: () => new Set(['IFCFOO', 'IFCBAR']),
    ts: () => new Set(['IFCFOO', 'IFCBAR']),
    rustLabel: 'fake.rs',
    tsLabel: 'fake.ts',
  };
  const { failures, vacuous } = checkConcept(concept);
  assert.equal(vacuous, false);
  assert.deepEqual(failures, []);
});

// -- under-read guard (review finding: a "secondary array" refactor of
// relationships.rs, or a 4th TS `*_REL_TYPES` Set, is otherwise invisible to
// the bounded extractors and produces a SILENT PASS rather than a failure) --

test('RELATIONSHIPS UNDER-READ: RED when a sibling `let extra_rel_types = [...]` array appears alongside `rel_types`', () => {
  // Reproduces the review-verified silent pass: a later patch that adds
  // genuinely new relationship types via a second bounded array, rather than
  // extending the one this extractor reads, must not compare as clean.
  const rust = replaceOnce(
    real.RUST_REL,
    'let rel_types = [',
    'let extra_rel_types = ["IFCRELASSIGNSTOPRODUCT"];\n    let rel_types = [',
  );
  const { status, out } = runOn({ RUST_REL: rust });
  assert.equal(status, 1, out);
  assert.match(out, /rustRelationshipTypes: found a binding `extra_rel_types`/);
  assert.match(out, /extractor may be under-reading; update it/);
  assert.match(out, /this gate refused to compare it/);
});

test('RELATIONSHIPS UNDER-READ: a sibling array whose name does not look like a types binding does not false-positive', () => {
  // `nameFilter: /types/i` should not fire on an unrelated helper array that
  // happens to also be bounded by `let NAME = [ ... ];`.
  const rust = replaceOnce(
    real.RUST_REL,
    'let rel_types = [',
    'let unrelated_helper = ["not an ifc type", "also not one"];\n    let rel_types = [',
  );
  const { status, out } = runOn({ RUST_REL: rust });
  assert.equal(status, 0, out);
});

test('RELATIONSHIPS UNDER-READ: RED when a 4th `*_REL_TYPES` Set appears on the TS side alongside the recognized three', () => {
  const ts = replaceOnce(
    real.TS_REL_INDEXES,
    'export const HIERARCHY_REL_TYPES: ReadonlySet<string> = new Set(',
    "export const PORT_REL_TYPES = new Set([\n    'IFCRELCONNECTSPORTS',\n]);\nexport const HIERARCHY_REL_TYPES: ReadonlySet<string> = new Set(",
  );
  const { status, out } = runOn({ TS_REL_INDEXES: ts });
  assert.equal(status, 1, out);
  assert.match(out, /tsRelationshipTypes: found a binding `PORT_REL_TYPES`/);
  assert.match(out, /extractor may be under-reading; update it/);
});

test('RELATIONSHIPS UNDER-READ: an unrelated `*_TYPES` Set (not `*_REL_TYPES`) does not false-positive on the TS side', () => {
  // GEOMETRY_TYPES/SPATIAL_TYPES/etc. already coexist in this file with
  // uppercase IFC-looking literals; the nameFilter must not treat them as an
  // unread relationship-types sibling, or the real tree would fail this gate.
  assert.ok(real.TS_REL_INDEXES.includes('export const GEOMETRY_TYPES = new Set(['));
  const { status } = runOn({});
  assert.equal(status, 0);
});

// -- under-read guard, extended to spatialTypes and quantities: the same
// bounded-single-region shape existed for these two concepts too, unguarded,
// until this hardening. Reproduces the identical silent-pass on each. --

test('SPATIAL TYPES UNDER-READ: RED when a sibling `is_X_spatial_type` closure appears alongside `is_spatial_type` on the Rust side', () => {
  const rust = replaceOnce(
    real.RUST_SPATIAL,
    'let is_spatial_type = |type_name: &str| {',
    'let is_new_kind_spatial_type = |type_name: &str| {\n' +
      '        matches!(type_name.to_uppercase().as_str(), "IFCNEWSPATIALKIND")\n' +
      '    };\n' +
      '    let is_spatial_type = |type_name: &str| {',
  );
  const { status, out } = runOn({ RUST_SPATIAL: rust });
  assert.equal(status, 1, out);
  assert.match(out, /rustSpatialTypes: found a binding `is_new_kind_spatial_type`/);
  assert.match(out, /extractor may be under-reading; update it/);
});

test('SPATIAL TYPES UNDER-READ: RED when a 5th `*_TYPE_ENUMS` array appears on the TS side alongside the recognized four', () => {
  const ts = replaceOnce(
    real.TS_SPATIAL,
    'export const SPATIAL_STRUCTURE_TYPE_ENUMS = [',
    'export const MARINE_LIKE_SPATIAL_TYPE_ENUMS = [\n  IfcTypeEnum.IfcMarineFacility,\n] as const;\nexport const SPATIAL_STRUCTURE_TYPE_ENUMS = [',
  );
  const { status, out } = runOn({ TS_SPATIAL: ts });
  assert.equal(status, 1, out);
  assert.match(out, /tsSpatialTypes: found a binding `MARINE_LIKE_SPATIAL_TYPE_ENUMS`/);
  assert.match(out, /extractor may be under-reading; update it/);
});

test('SPATIAL TYPES UNDER-READ: the real tree (master list plus its three known subset lists) does not false-positive', () => {
  const { status, out } = runOn({});
  assert.equal(status, 0, out);
});

test('QUANTITIES UNDER-READ: RED when a sibling quantity map appears alongside `QUANTITY_TYPE_MAP` on the TS side', () => {
  const ts = replaceOnce(
    real.TS_REL_INDEXES,
    'export const QUANTITY_TYPE_MAP: Record<string, QuantityType> = {',
    "export const LEGACY_QUANTITY_MAP: Record<string, QuantityType> = {\n    'IFCQUANTITYNUMBER': QuantityType.Number,\n};\nexport const QUANTITY_TYPE_MAP: Record<string, QuantityType> = {",
  );
  const { status, out } = runOn({ TS_REL_INDEXES: ts });
  assert.equal(status, 1, out);
  assert.match(out, /tsQuantityTypes: found a binding `LEGACY_QUANTITY_MAP`/);
  assert.match(out, /extractor may be under-reading; update it/);
});

test('mutation control: disabling the under-read detector lets the same silent-pass repro go green again', () => {
  // Directly verifies the guard is load-bearing: with the detector's body
  // replaced by an early return (simulating it being disabled/deleted), the
  // exact same sibling-array mutation that RED above must go GREEN again.
  const libPath = join(SCRIPTS, 'lib', 'server-browser-type-extractors.mjs');
  const libSrc = readFileSync(libPath, 'utf8');
  const anchor =
    "export function assertNoUnrecognizedSiblingBindings(\n  code,\n  { bindingPattern, valuePattern, nameFilter, recognizedNames, label },\n) {\n";
  // @source-text-assertion-ok mutation anchor guard, not a subject assertion
  assert.ok(libSrc.includes(anchor), 'assertNoUnrecognizedSiblingBindings signature drifted');
  const mutatedLib = libSrc.replace(anchor, `${anchor}  return; // mutated: detector disabled\n`);

  const dir = mkdtempSync(join(tmpdir(), 'server-browser-type-parity-mutation-'));
  try {
    for (const [key, rel] of Object.entries(FILES)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, real[key]);
    }
    // Overwrite the checker's own lib copy is not possible via --root (the
    // checker always imports its OWN scripts/lib, not one under --root), so
    // this test instead runs the checker's real entry point but against a
    // temp copy of the WHOLE scripts dir with the mutated lib swapped in.
    const scriptsCopy = join(dir, '__scripts__');
    mkdirSync(scriptsCopy, { recursive: true });
    // Whole-`lib`-dir copy (not an enumerated file list): server-browser-type-extractors.mjs
    // now has its own sibling modules (hierarchy-schema-loader.mjs,
    // ts-source-loader.mjs, #4672) — an enumerated copy silently drifts out
    // of sync with its import graph every time a new sibling is split out,
    // which is exactly the shape of bug this whole file's method (copy the
    // REAL sources, mutate one) exists to avoid.
    writeFileSync(join(scriptsCopy, 'check-server-browser-type-parity.mjs'), readFileSync(CHECKER, 'utf8'));
    cpSync(join(SCRIPTS, 'lib'), join(scriptsCopy, 'lib'), { recursive: true });
    writeFileSync(join(scriptsCopy, 'lib', 'server-browser-type-extractors.mjs'), mutatedLib);

    const relMutated = replaceOnce(
      real.RUST_REL,
      'let rel_types = [',
      'let extra_rel_types = ["IFCRELASSIGNSTOPRODUCT"];\n    let rel_types = [',
    );
    for (const [key, rel] of Object.entries(FILES)) {
      const content = key === 'RUST_REL' ? relMutated : real[key];
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }

    const r = spawnSync(
      process.execPath,
      [join(scriptsCopy, 'check-server-browser-type-parity.mjs'), '--root', dir],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /check-server-browser-type-parity: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- vacuity guard claim correction (review finding: the header claims BOTH
// sides are guarded for every concept; `properties` TS-side never can be,
// because tsPropertyTypes seeds IFCPROPERTYSINGLEVALUE unconditionally) ------

test('PROPERTIES VACUITY: emptying the Rust side alone still fires the vacuity guard', () => {
  const { status, out } = runOn({ RUST_PROPS: '// nothing\n' });
  assert.equal(status, 1, out);
  assert.match(out, /no types extracted from apps\/server\/src\/services\/data_model\/properties\.rs/);
});

test('PROPERTIES VACUITY (documents the corrected claim): emptying the TS side alone does NOT fire the vacuity guard, because the extractor unconditionally seeds IFCPROPERTYSINGLEVALUE', () => {
  const { status, out } = runOn({ TS_PROPS: '// nothing\n' });
  // ts.size can never be 0 for this concept, so the vacuity guard's TS half
  // can never trip here — the real (non-silent) failure mode this decays to
  // is a plain "Rust has these types, TS does not" divergence instead.
  assert.equal(status, 1, out);
  assert.doesNotMatch(out, /no types extracted from packages\/parser\/src\/property-value-parser\.ts/);
  assert.match(out, /the TS parser .* does not/);
});

// -- staleAllowlistEntries() unit-level sanity (no subprocess) ----------
//
// #3979: nothing ever un-mutes an ALLOWLIST entry once its divergence is
// fixed. These test the pure detector directly against synthetic rust/ts
// sets, same pattern as the checkConcept() unit tests above.

test('staleAllowlistEntries(): an entry present on exactly one side is NOT stale (still a real divergence)', () => {
  const conceptSets = { fake: { rust: new Set(['IFCFOO']), ts: new Set(['IFCFOO', 'IFCBAR']) } };
  const stale = staleAllowlistEntries(
    { 'fake:IFCBAR': { status: 'pending', note: 'still missing from rust' } },
    conceptSets,
  );
  assert.deepEqual(stale, []);
});

test('staleAllowlistEntries(): a `pending` entry now present on BOTH sides is stale', () => {
  const conceptSets = { fake: { rust: new Set(['IFCFOO', 'IFCBAR']), ts: new Set(['IFCFOO', 'IFCBAR']) } };
  const stale = staleAllowlistEntries(
    { 'fake:IFCBAR': { status: 'pending', note: 'the fix landed but nobody removed this' } },
    conceptSets,
  );
  assert.equal(stale.length, 1);
  assert.equal(stale[0].key, 'fake:IFCBAR');
  assert.match(stale[0].reason, /BOTH/);
});

test('staleAllowlistEntries(): a `deliberate` entry now present on BOTH sides is ALSO stale — deliberate is not an exemption', () => {
  const conceptSets = { fake: { rust: new Set(['IFCFOO']), ts: new Set(['IFCFOO']) } };
  const stale = staleAllowlistEntries(
    { 'fake:IFCFOO': { status: 'deliberate', note: 'settled trade-off that no longer applies' } },
    conceptSets,
  );
  assert.equal(stale.length, 1);
  assert.equal(stale[0].status, 'deliberate');
});

test('staleAllowlistEntries(): an entry present on NEITHER side is stale, with a distinct reason', () => {
  const conceptSets = { fake: { rust: new Set(['IFCFOO']), ts: new Set(['IFCFOO']) } };
  const stale = staleAllowlistEntries(
    { 'fake:IFCRENAMEDAWAY': { status: 'pending', note: 'type was renamed' } },
    conceptSets,
  );
  assert.equal(stale.length, 1);
  assert.match(stale[0].reason, /NEITHER/);
});

test('staleAllowlistEntries(): a concept missing from conceptSets (vacuous/under-read this run) is skipped, not judged', () => {
  const stale = staleAllowlistEntries(
    { 'notChecked:IFCFOO': { status: 'pending', note: 'concept not in conceptSets' } },
    {},
  );
  assert.deepEqual(stale, []);
});

test('the real ALLOWLIST has zero stale entries against the real sources today', () => {
  const conceptSets = {
    relationships: { rust: rustRelationshipTypes(real.RUST_REL), ts: tsRelationshipTypes(real.TS_REL_INDEXES) },
    spatialTypes: { rust: rustSpatialTypes(real.RUST_SPATIAL), ts: tsSpatialTypes(real.TS_SPATIAL) },
    properties: { rust: rustPropertyTypes(real.RUST_PROPS), ts: tsPropertyTypes(real.TS_PROPS) },
    quantities: {
      // TS_REL_INDEXES and the quantity map live in the SAME file
      // (columnar-parser-indexes.ts) — reuse the already-read content.
      rust: rustQuantityTypes(real.RUST_QTY),
      ts: tsQuantityTypes(real.TS_REL_INDEXES, real.TS_QTY_COLLECT),
    },
    materials: { rust: rustMaterialTypes(real.RUST_MATERIALS), ts: tsMaterialTypes(real.TS_MATERIALS) },
  };
  const stale = staleAllowlistEntries(ALLOWLIST, conceptSets);
  assert.deepEqual(
    stale.map((s) => s.key),
    [],
    `stale ALLOWLIST entries found — the divergence they cite no longer exists, remove them: ${JSON.stringify(stale)}`,
  );
});

// -- staleAllowlistEntries() end-to-end via subprocess (real gate output) --
//
// Uses the same "copy scripts/ to a temp dir with one file mutated, run the
// real checker via --root against the real sources" technique as the
// under-read tests above, so this exercises the actual CLI output/exit code
// path, not just the pure detector.

test('E2E: a FAKE allowlist entry for a type both sides already handle identically turns the gate RED and says to remove it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-browser-type-parity-stale-'));
  try {
    for (const [key, rel] of Object.entries(FILES)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, real[key]);
    }
    const scriptsCopy = join(dir, '__scripts__');
    // Whole-`lib`-dir copy — see the identical comment on the mutation
    // control test above for why an enumerated file list drifts.
    cpSync(join(SCRIPTS, 'lib'), join(scriptsCopy, 'lib'), { recursive: true });
    // ALLOWLIST moved to its own module (scripts/lib/server-browser-type-allowlist.mjs,
    // split out purely to stay under the module-size budget once #4205's
    // rows were added — see that file's header), so the fabricated stale
    // entry is spliced into ITS source, not the checker's.
    const allowlistSrc = readFileSync(join(SCRIPTS, 'lib', 'server-browser-type-allowlist.mjs'), 'utf8');
    const marker = 'export const ALLOWLIST = {\n';
    // @source-text-assertion-ok mutation anchor guard, not a subject assertion
    assert.ok(allowlistSrc.includes(marker), 'ALLOWLIST marker drifted');
    // IFCRELAGGREGATES is handled by both relationships.rs and
    // columnar-parser-indexes.ts today (asserted by the RELATIONSHIPS RED
    // test above, which removes it from the Rust side specifically because
    // it is present on both sides in the unmutated tree) — an allowlist
    // entry for it describes a divergence that does not exist.
    const mutatedAllowlist = allowlistSrc.replace(
      marker,
      `${marker}  'relationships:IFCRELAGGREGATES': { status: 'pending', note: 'TEST: fabricated stale entry' },\n`,
    );
    writeFileSync(join(scriptsCopy, 'check-server-browser-type-parity.mjs'), readFileSync(CHECKER, 'utf8'));
    writeFileSync(join(scriptsCopy, 'lib', 'server-browser-type-allowlist.mjs'), mutatedAllowlist);
    const r = spawnSync(
      process.execPath,
      [join(scriptsCopy, 'check-server-browser-type-parity.mjs'), '--root', dir],
      { encoding: 'utf8' },
    );
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 1, out);
    assert.match(out, /stale ALLOWLIST entries/);
    assert.match(out, /relationships:IFCRELAGGREGATES/);
    assert.match(out, /remove this entry from ALLOWLIST/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
