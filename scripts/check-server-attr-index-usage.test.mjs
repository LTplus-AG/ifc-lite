#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-server-attr-index-usage.mjs.
 *
 * Method matches packages/data/scripts/generate-ifc-schema.test.ts (the
 * pattern check-source-text-assertions.mjs's own header names as the fix for
 * the exact false positive this shape risks, #3174): mutate a copy of the
 * REAL source IN PLACE on disk in a throwaway temp dir, then run the real
 * checker as a subprocess with ZERO arguments carrying file content, and
 * assert only on its stdout/stderr. `runChecker()` below takes no parameters,
 * so nothing here reads a file into a variable that a later assertion's
 * predicate is ever applied to — the assertions are on subprocess OUTPUT, not
 * source text.
 *
 * The first RED case below reintroduces the EXACT original #3949 defect
 * (server reading GlobalId/Name at hardcoded IfcRoot indices 0/2) to prove
 * this gate catches the specific regression it exists for.
 *
 * Run: node --test scripts/check-server-attr-index-usage.test.mjs
 * (wired as a step of the CI node-test job in .github/workflows/test.yml).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFieldReads, checkUsage, METADATA_REL } from './check-server-attr-index-usage.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS, '..');
const CHECKER = join(SCRIPTS, 'check-server-attr-index-usage.mjs');

const realRust = readFileSync(join(REPO_ROOT, METADATA_REL), 'utf8');

// One throwaway temp tree for the whole file, holding a copy of metadata.rs
// this suite mutates in place and resets between tests — never the real repo
// file.
const workDir = mkdtempSync(join(tmpdir(), 'attr-index-usage-'));
const metadataAbs = join(workDir, METADATA_REL);
mkdirSync(dirname(metadataAbs), { recursive: true });
writeFileSync(metadataAbs, realRust);

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Resets the temp copy back to the real, unmutated source. */
function reset() {
  writeFileSync(metadataAbs, realRust);
}

/** Applies one in-place edit to the temp copy, failing if it was a no-op —
 * so a mutation anchor that has drifted cannot silently leave a test
 * asserting nothing. */
function mutate(from, to) {
  const before = readFileSync(metadataAbs, 'utf8');
  const after = before.replace(from, to);
  assert.notEqual(after, before, `mutation anchor drifted, not found in source: ${from}`);
  writeFileSync(metadataAbs, after);
}

/** Runs the real checker against the temp tree. Takes no arguments carrying
 * file content — it reads only the already-written temp copy via --root —
 * so its result is a subprocess OUTPUT, not source text run back through a
 * predicate. */
function runChecker() {
  const r = spawnSync(process.execPath, [CHECKER, '--root', workDir], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('the unmutated repo passes', () => {
  reset();
  const { status, out } = runChecker();
  assert.equal(status, 0, out);
  assert.match(out, /check-server-attr-index-usage: OK \(6\/6 fields wired/);
});

test('GREEN (no false positive): a correctly-wired read reformatted onto multiple lines by rustfmt is still found, not reported as vanished', () => {
  // Adversarial-review finding: the original regex required `accessor\(&entity,`
  // as one unbroken literal, with no `\s*` between the opening paren and
  // `&entity`. A call rustfmt wraps across lines once it exceeds the line
  // length limit — realistic the moment `idx` or a field name grows a few
  // characters — puts a newline exactly there, so the regex silently failed
  // to match at all. The `underRead` path then reported `global_id` as
  // MISSING and warned the function "may have moved, been renamed, or been
  // reshaped" — a false vacuity failure over pure reformatting, not the
  // targeted "read as a literal" failure this gate exists to give.
  reset();
  mutate(
    'let global_id = string_at(&entity, idx.global_id);',
    'let global_id = string_at(\n                &entity,\n                idx.global_id,\n            );',
  );
  const { status, out } = runChecker();
  assert.equal(status, 0, out);
  assert.match(out, /check-server-attr-index-usage: OK \(6\/6 fields wired/);
});

test('RED: reintroducing the exact original #3949 defect (GlobalId/Name at hardcoded IfcRoot indices 0/2) fails, naming both fields', () => {
  reset();
  mutate(
    'let global_id = string_at(&entity, idx.global_id);\n            let name = string_at(&entity, idx.name);',
    'let global_id = string_at(&entity, 0);\n            let name = string_at(&entity, 2);',
  );
  const { status, out } = runChecker();
  assert.equal(status, 1, out);
  assert.match(out, /`global_id` is read as `0`, not `idx\.global_id`/);
  assert.match(out, /`name` is read as `2`, not `idx\.name`/);
  assert.match(out, /This is the exact shape of issue #3949/);
});

test('RED: a single field silently hardcoded (object_type) is caught even though every other field is correct', () => {
  reset();
  mutate('let object_type = string_at(&entity, idx.object_type);', 'let object_type = string_at(&entity, 4);');
  const { status, out } = runChecker();
  assert.equal(status, 1, out);
  assert.match(out, /`object_type` is read as `4`, not `idx\.object_type`/);
  // Every other field stayed correctly wired — only the mutated one is named.
  assert.doesNotMatch(out, /`global_id` is read as/);
  assert.doesNotMatch(out, /`name` is read as/);
});

test('RED: predefined_type hardcoded via enum_at is caught (not just string_at fields)', () => {
  reset();
  mutate('let predefined_type = enum_at(&entity, idx.predefined_type);', 'let predefined_type = enum_at(&entity, 8);');
  const { status, out } = runChecker();
  assert.equal(status, 1, out);
  assert.match(out, /`predefined_type` is read as `8`, not `idx\.predefined_type`/);
});

test('RED (anti-vacuity): if the function is renamed/moved so none of the six assignments can be found, the gate fails loudly rather than reporting OK', () => {
  writeFileSync(metadataAbs, '// extract_entity_metadata has moved elsewhere\n');
  const { status, out } = runChecker();
  assert.equal(status, 1, out);
  assert.match(out, /only found 0\/6 expected field-read assignments/);
  assert.match(out, /this gate has stopped reading the real code/);
  // Must not be confused with a real usage failure - it's a distinct category.
  assert.match(out, /This gate could not find all six expected field-read assignments, so it\ncompared nothing/);
});

test('RED (anti-vacuity): finding only SOME of the six fields (partial drift) still fails loudly, not partially OK', () => {
  reset();
  // Strip just the predefined_type line — 5 of 6 assignments remain readable,
  // which must still be treated as under-read (0 real comparisons made for
  // the field that vanished), not "5/6 pass, ignore the missing one".
  mutate('let predefined_type = enum_at(&entity, idx.predefined_type);', '// predefined_type computed elsewhere now');
  const { status, out } = runChecker();
  assert.equal(status, 1, out);
  assert.match(out, /only found 5\/6 expected field-read assignments/);
  assert.match(out, /missing: predefined_type/);
});

// Hand-written, not read from any file — unit-testing the extractor
// functions directly against a literal fixture shaped like the real
// function, so these do not pair a file read with a predicate the way the
// mutation-based subprocess tests above (deliberately) do not either.
const CORRECTLY_WIRED_FIXTURE = `
            let idx = root_attr_indices(&upper).unwrap_or(UNKNOWN_TYPE_FALLBACK);
            let global_id = string_at(&entity, idx.global_id);
            let name = string_at(&entity, idx.name);
            let description = string_at(&entity, idx.description);
            let object_type = string_at(&entity, idx.object_type);
            let tag = string_at(&entity, idx.tag);
            let predefined_type = enum_at(&entity, idx.predefined_type);
`;

test('extractFieldReads finds all six assignments with the expected idx.<field> expression on a correctly-wired fixture', () => {
  const reads = extractFieldReads(CORRECTLY_WIRED_FIXTURE);
  assert.equal(reads.size, 6);
  for (const field of ['global_id', 'name', 'description', 'object_type', 'tag', 'predefined_type']) {
    assert.equal(reads.get(field), `idx.${field}`, `${field} should read idx.${field} on a correctly-wired fixture`);
  }
});

test('checkUsage on a correctly-wired fixture returns no failures', () => {
  const { failures, underRead } = checkUsage(CORRECTLY_WIRED_FIXTURE);
  assert.deepEqual(failures, []);
  assert.equal(underRead, false);
});

test('a field-read named only in a comment does not count as found', () => {
  const rust = '// let global_id = string_at(&entity, idx.global_id);\n';
  const reads = extractFieldReads(rust);
  assert.equal(reads.has('global_id'), false);
});
