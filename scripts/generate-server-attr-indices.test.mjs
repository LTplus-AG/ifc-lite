#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Black-box regression harness for scripts/generate-server-attr-indices.mjs.
 *
 * Method mirrors scripts/check-module-size.test.mjs: each case builds a
 * synthetic tree in a temp dir outside the repo — a fake
 * `packages/parser/dist/index.js` plus a VERBATIM byte copy of the generator
 * (it resolves the repo root from its own location, so it has to live in the
 * tree) — runs it, and asserts the exit code AND the message. Nothing here
 * reads the generator's source or its constants.
 *
 * The cases that matter are the ones where this generator could succeed having
 * derived nothing usable. It has two such levels and they fail differently:
 *
 *   - no rows      — an empty or half-built dist writes a `match` with no arms,
 *                    so every KNOWN type falls back to the unknown-type indices
 *                    [3,4,7]. Caught by the row floor.
 *   - no RESOLVED  — `allAttributes` is optional on the registry's entity
 *     rows        metadata and `getAllAttributesForEntity` returns
 *                    `metadata?.allAttributes || []`, so a fully populated
 *                    `entities` map with no `allAttributes` writes one arm per
 *                    type with every index -1. The row count looks healthy; the
 *                    table says no known type declares any of the four
 *                    attributes, and -1 means "never fall back". Measured on
 *                    that exact shape before the resolved floor existed: 776
 *                    arms, exit 0, and `--check` printing ✓ from then on.
 *
 * Both are pinned below as executable "must exit non-zero, and must not touch
 * the committed file" cases, in BOTH modes.
 *
 * Run: node --test scripts/generate-server-attr-indices.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = join(ROOT, 'scripts', 'generate-server-attr-indices.mjs');
const OUT_REL = 'apps/server/src/services/data_model/generated/attr_indices.rs';

/** The four attributes the table carries, in the generator's own order. */
const FULL_ATTRS = ['GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType', 'Tag', 'PredefinedType'];

const cleanup = [];
process.on('exit', () => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

/**
 * Build a tree whose registry exposes `entities` entity types, of which the
 * first `resolved` return a real attribute list and the rest return `[]` — the
 * shape `metadata?.allAttributes || []` produces when `allAttributes` is gone.
 *
 * `committed` seeds the output path with that text (omit to leave it absent).
 */
function tree({ entities, resolved, committed, registryName = 'IFC4_ADD2_TC1' }) {
  const dir = mkdtempSync(join(tmpdir(), 'attr-indices-'));
  cleanup.push(dir);

  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'packages/parser/dist'), { recursive: true });
  // Verbatim copy — the generator under test, byte for byte.
  copyFileSync(GENERATOR, join(dir, 'scripts', 'generate-server-attr-indices.mjs'));

  writeFileSync(
    join(dir, 'packages/parser/dist/index.js'),
    `export const SCHEMA_REGISTRY = {\n` +
      `  name: ${JSON.stringify(registryName)},\n` +
      `  entities: Object.fromEntries(\n` +
      `    Array.from({ length: ${entities} }, (_, i) => ['IfcProbe' + i, { name: 'IfcProbe' + i }]),\n` +
      `  ),\n` +
      `};\n` +
      `const FULL = ${JSON.stringify(FULL_ATTRS)};\n` +
      `export function getAttributeNames(type) {\n` +
      `  const i = Number(type.slice('IfcProbe'.length));\n` +
      // Mirrors `getAllAttributesForEntity`: `metadata?.allAttributes || []`.
      `  return i < ${resolved} ? FULL : [];\n` +
      `}\n`,
  );

  if (committed !== undefined) {
    mkdirSync(join(dir, dirname(OUT_REL)), { recursive: true });
    writeFileSync(join(dir, OUT_REL), committed);
  }
  return dir;
}

/**
 * A tree whose `SCHEMA_REGISTRY.entities` is missing entirely — distinct from
 * `tree({ entities: 0, ... })`, which still yields `entities: {}` (a real,
 * empty object) and is caught by ROW_FLOOR instead. This is the case the
 * empty-registry guard (checked before either floor) exists for: a stale or
 * broken build whose `entities` key isn't there, or isn't an object, at all.
 */
function brokenDist() {
  const dir = mkdtempSync(join(tmpdir(), 'attr-indices-'));
  cleanup.push(dir);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'packages/parser/dist'), { recursive: true });
  copyFileSync(GENERATOR, join(dir, 'scripts', 'generate-server-attr-indices.mjs'));
  writeFileSync(
    join(dir, 'packages/parser/dist/index.js'),
    `export const SCHEMA_REGISTRY = { name: 'IFC4_ADD2_TC1' };\n` +
      `export function getAttributeNames() { return []; }\n`,
  );
  return dir;
}

function run(dir, ...args) {
  const res = spawnSync(process.execPath, [join(dir, 'scripts', 'generate-server-attr-indices.mjs'), ...args], {
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

/** sha256 of the output file, or null when it does not exist. */
function outHash(dir) {
  const p = join(dir, OUT_REL);
  return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null;
}

/** The text a healthy run would produce for this tree — used as seed content. */
function healthyTable(dir) {
  run(dir);
  return readFileSync(join(dir, OUT_REL), 'utf8');
}

test('a healthy registry writes one arm per type', () => {
  const dir = tree({ entities: 776, resolved: 488 });
  const { code, out } = run(dir);
  assert.equal(code, 0, out);
  assert.match(out, /\(776 types, registry IFC4_ADD2_TC1\)/);
  const rs = readFileSync(join(dir, OUT_REL), 'utf8');
  assert.equal((rs.match(/=> Some\(RootAttrIndices/g) ?? []).length, 776);
  assert.match(rs, /"IFCPROBE0" => Some\(RootAttrIndices \{ description: 3, object_type: 4, tag: 5, predefined_type: 6 \}\)/);
});

test('a full entities map with no allAttributes is refused, not written', () => {
  // The row count is healthy — 776 — and every single row would be [-1,-1,-1,-1].
  const seed = healthyTable(tree({ entities: 776, resolved: 488 }));
  const dir = tree({ entities: 776, resolved: 0, committed: seed });
  const before = outHash(dir);

  const { code, out } = run(dir);
  assert.equal(code, 1, out);
  assert.match(out, /776 entity type\(s\), but only 0 of them resolve ANY of/);
  assert.match(out, /Description\/ObjectType\/Tag\/PredefinedType/);
  assert.match(out, /Refusing to emit/);
  // A generator that half-writes on refusal is worse than one that writes garbage.
  assert.equal(outHash(dir), before, 'refusal must leave the committed table byte-identical');
});

test('--check does not bless a table derived from an unresolvable registry', () => {
  const seed = healthyTable(tree({ entities: 776, resolved: 488 }));
  const dir = tree({ entities: 776, resolved: 0, committed: seed });
  const before = outHash(dir);

  const { code, out } = run(dir, '--check');
  assert.equal(code, 1, out);
  assert.match(out, /only 0 of them resolve ANY of/);
  assert.match(out, /Refusing to compare against/);
  // The success line specifically — the refusal text quotes "in sync" itself.
  assert.doesNotMatch(out, /✓ attr_indices\.rs in sync/);
  assert.equal(outHash(dir), before);
});

test('the resolved floor sits at 400: 399 refuses, 400 passes', () => {
  const low = run(tree({ entities: 776, resolved: 399 }));
  assert.equal(low.code, 1, low.out);
  assert.match(low.out, /only 399 of them resolve ANY of/);

  const dir = tree({ entities: 776, resolved: 400 });
  const ok = run(dir);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(outHash(dir) !== null, true);
});

test('the row floor sits at 700: 699 refuses, 700 passes', () => {
  // Seed a committed table (from a healthy 700-entity run) so the refusal
  // path's byte-identity claim is actually pinned, not just asserted for the
  // RESOLVED_FLOOR and empty-registry cases.
  const seed = healthyTable(tree({ entities: 700, resolved: 488 }));
  const dir = tree({ entities: 699, resolved: 488, committed: seed });
  const before = outHash(dir);

  const low = run(dir);
  assert.equal(low.code, 1, low.out);
  assert.match(low.out, /yielded only 699 entity type\(s\); the floor is 700/);
  assert.equal(outHash(dir), before, 'refusal must leave the committed table byte-identical');

  const ok = run(tree({ entities: 700, resolved: 488 }));
  assert.equal(ok.code, 0, ok.out);
});

test('an empty entities map is refused in both modes and writes nothing', () => {
  for (const args of [[], ['--check']]) {
    const dir = tree({ entities: 0, resolved: 0 });
    const { code, out } = run(dir, ...args);
    assert.equal(code, 1, out);
    assert.match(out, /yielded only 0 entity type\(s\)/);
    assert.equal(outHash(dir), null, 'nothing may be written when the registry is empty');
  }
});

test('a registry with no entities map at all is refused by the named guard, not ROW_FLOOR', () => {
  for (const args of [[], ['--check']]) {
    const dir = brokenDist();
    const { code, out } = run(dir, ...args);
    assert.equal(code, 1, out);
    assert.match(out, /SCHEMA_REGISTRY\.entities is missing or not an object/);
    // Distinct from the `entities: {}` case: this must NOT be reported as the
    // row-floor refusal, since that would mean the guard did nothing this
    // shape didn't already get from ROW_FLOOR.
    assert.doesNotMatch(out, /yielded only/);
    assert.equal(outHash(dir), null, 'nothing may be written when entities is missing');
  }
});
