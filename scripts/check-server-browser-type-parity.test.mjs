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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConcept, ALLOWLIST, validateAllowlist } from './check-server-browser-type-parity.mjs';

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
 * to a temp dir and runs the checker on it. */
function runOn(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'server-browser-type-parity-'));
  try {
    for (const [key, rel] of Object.entries(FILES)) {
      const content = Object.hasOwn(overrides, key) ? overrides[key] : real[key];
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const r = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
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

// -- relationships -----------------------------------------------------

test('RELATIONSHIPS: RED when a type is removed from the Rust rel_types array', () => {
  const rust = replaceOnce(real.RUST_REL, '"IFCRELAGGREGATES",\n', '');
  const { status, out } = runOn({ RUST_REL: rust });
  assert.equal(status, 1, out);
  assert.match(out, /\[relationships\]/);
  assert.match(out, /TS parser .* handles `IFCRELAGGREGATES` but the Rust server .* does not/);
});

test('RELATIONSHIPS: RED when a type not on the allowlist is removed from the TS side', () => {
  // IFCRELDEFINESBYPROPERTIES is on BOTH sides today (via PROPERTY_REL_TYPES
  // on the TS side) and is not allowlisted, so emptying that set must
  // surface as "Rust has it, TS does not" — proving the comparison is
  // symmetric and not just checking one direction.
  const ts = replaceOnce(
    real.TS_REL_INDEXES,
    "export const PROPERTY_REL_TYPES = new Set([\n    'IFCRELDEFINESBYPROPERTIES',\n]);",
    'export const PROPERTY_REL_TYPES = new Set([]);',
  );
  const { status, out } = runOn({ TS_REL_INDEXES: ts });
  assert.equal(status, 1, out);
  assert.match(out, /Rust server .* handles `IFCRELDEFINESBYPROPERTIES` but the TS parser .* does not/);
});

test('RELATIONSHIPS: an allowlisted divergence (IFCRELNESTS) does not fail on its own', () => {
  assert.ok(Object.hasOwn(ALLOWLIST, 'relationships:IFCRELNESTS'));
  const { status, out } = runOn({});
  assert.equal(status, 0, out);
});

test('RELATIONSHIPS: a FAKE divergence not on the allowlist still fails (allowlist does not over-suppress)', () => {
  // Add a type to the TS set that the Rust side genuinely lacks and that is
  // NOT in ALLOWLIST — proves the allowlist suppresses only what it names.
  assert.ok(!Object.hasOwn(ALLOWLIST, 'relationships:IFCRELINVENTEDFAKETYPE'));
  const ts = replaceOnce(
    real.TS_REL_INDEXES,
    "export const HIERARCHY_REL_TYPES = new Set([",
    "export const HIERARCHY_REL_TYPES = new Set([\n    'IFCRELINVENTEDFAKETYPE',",
  );
  const { status, out } = runOn({ TS_REL_INDEXES: ts });
  assert.equal(status, 1, out);
  assert.match(out, /`IFCRELINVENTEDFAKETYPE`/);
});

test('RELATIONSHIPS: adding a type to BOTH sides keeps it passing', () => {
  const rust = replaceOnce(
    real.RUST_REL,
    'let rel_types = [',
    'let rel_types = [\n        "IFCRELINVENTEDFAKETYPE",',
  );
  const ts = replaceOnce(
    real.TS_REL_INDEXES,
    "export const HIERARCHY_REL_TYPES = new Set([",
    "export const HIERARCHY_REL_TYPES = new Set([\n    'IFCRELINVENTEDFAKETYPE',",
  );
  const { status, out } = runOn({ RUST_REL: rust, TS_REL_INDEXES: ts });
  assert.equal(status, 0, out);
});

// -- spatial types -------------------------------------------------------

test('SPATIAL TYPES: RED when a type is removed from the Rust is_spatial_type arm', () => {
  const rust = replaceOnce(real.RUST_SPATIAL, '"IFCBUILDINGSTOREY"\n', '');
  const { status, out } = runOn({ RUST_SPATIAL: rust });
  assert.equal(status, 1, out);
  assert.match(out, /\[spatialTypes\]/);
  assert.match(out, /TS parser .* handles `IFCBUILDINGSTOREY` but the Rust server .* does not/);
});

test('SPATIAL TYPES: an allowlisted divergence (IfcSpatialZone, #3965/#3973) does not fail on its own', () => {
  assert.ok(Object.hasOwn(ALLOWLIST, 'spatialTypes:IFCSPATIALZONE'));
  const { status, out } = runOn({});
  assert.equal(status, 0, out);
});

test('SPATIAL TYPES: removing IfcSite from the TS enum list surfaces as a TS-side gap', () => {
  const ts = replaceOnce(real.TS_SPATIAL, '  IfcTypeEnum.IfcSite,\n', '');
  const { status, out } = runOn({ TS_SPATIAL: ts });
  assert.equal(status, 1, out);
  assert.match(out, /Rust server .* handles `IFCSITE` but the TS parser .* does not/);
});

// -- properties -----------------------------------------------------------

test('PROPERTIES: an allowlisted divergence (IFCCOMPLEXPROPERTY, #3963/#3971) does not fail on its own', () => {
  assert.ok(Object.hasOwn(ALLOWLIST, 'properties:IFCCOMPLEXPROPERTY'));
  const { status, out } = runOn({});
  assert.equal(status, 0, out);
});

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

test('QUANTITIES: RED when the deliberate gap marker is deleted from the TS side without touching the allowlist', () => {
  // If quantity-collect.ts stops naming IfcPhysicalComplexQuantity at all,
  // the type disappears from the TS set entirely, and since it is still
  // allowlisted, both extractors simply agree it is absent from the pair
  // (Rust never had it either) -- no failure. This proves the allowlist
  // entry only suppresses the CURRENT direction (Rust-missing), not an
  // arbitrary one: flip it around by having the type appear on the RUST side
  // only and confirm parity now compares two non-empty, disjoint concerns
  // correctly instead of vacuously.
  const rust = replaceOnce(
    real.RUST_QTY,
    'ifc_type.eq_ignore_ascii_case("IFCQUANTITYLENGTH")',
    'ifc_type.eq_ignore_ascii_case("IFCQUANTITYLENGTH") || ifc_type.eq_ignore_ascii_case("IFCPHYSICALCOMPLEXQUANTITY")',
  );
  const { status, out } = runOn({ RUST_QTY: rust });
  // Now BOTH sides name IFCPHYSICALCOMPLEXQUANTITY, which is allowlisted as
  // a Rust-missing gap; Rust now also has it, so the set intersects fully —
  // still passes, proving the allowlist does not force a divergence to
  // exist, it only tolerates one if present.
  assert.equal(status, 0, out);
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
    "export const HIERARCHY_REL_TYPES = new Set([",
    "export const PORT_REL_TYPES = new Set([\n    'IFCRELCONNECTSPORTS',\n]);\nexport const HIERARCHY_REL_TYPES = new Set([",
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
    mkdirSync(join(scriptsCopy, 'lib'), { recursive: true });
    writeFileSync(join(scriptsCopy, 'check-server-browser-type-parity.mjs'), readFileSync(CHECKER, 'utf8'));
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
