#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ratchet: every committed generated-schema file must be byte-identical to a
 * fresh regeneration from its committed .exp / upstream source.
 *
 * THE GAP (#3565). `packages/codegen` turns the committed IFC4 and IFC4X3
 * EXPRESS schemas into `packages/codegen/generated/{ifc4,ifc4x3}/*.ts`, and
 * `packages/parser/src/generated/*.ts` is a hand-copied mirror of the IFC4
 * half (see `packages/codegen/INTEGRATION.md`). `packages/data` turns the
 * vendored `SchemaInfo.*.g.cs` files into
 * `packages/data/src/ifc-schema/generated/*.ts`. Nothing in CI regenerates
 * any of these and diffs the result against what's committed —
 * `scripts/check-generated.mjs`'s own header documents this gap by name (it
 * lists `check:bim-globals`, `check:server-attr-indices`,
 * `docs:check-generated`, `check:api-surface`, `cargo metadata --locked`,
 * and the opt-in Plato/wasm gates as the freshness gates that exist; codegen
 * output is not among them). A hand-edit that patches the generated file
 * instead of the generator can therefore live in the tree indefinitely: PR
 * #3565 found and fixed exactly that (commit 6ce40ddb0 hand-patched
 * `entities.ts`'s `UNIQUE IfcGridAxis[]` leak without touching the
 * generator, so `schema-registry.ts` — the file that actually ships in
 * `@ifc-lite/parser` — kept the wrong runtime metadata for every attribute
 * that inherits it).
 *
 * WHAT THIS DOES. For each target below: run the real generator against its
 * committed input into a fresh OS temp directory (never the repo tree), then
 * byte-compare every file against the committed output directory. Any
 * missing file, extra file, or content mismatch is a named FAIL.
 *
 *   1. `packages/codegen/generated/ifc4`    <- IFC4_ADD2_TC1.exp
 *   2. `packages/codegen/generated/ifc4x3`  <- IFC4X3.exp
 *   3. `packages/parser/src/generated`      <- IFC4_ADD2_TC1.exp (the same
 *      generation as (1); parser's copy is compared against it a second
 *      time because it is maintained as a separate committed artifact, not
 *      a symlink — see INTEGRATION.md "Copy Generated Files to Parser")
 *   4. `packages/data/src/ifc-schema/generated` <- `packages/data/scripts/
 *      upstream/SchemaInfo.*.g.cs`, via `generate-ifc-schema.ts` then
 *      `emit-entity-names.ts` (the second script reads the first's output,
 *      so both run against the same temp tree in sequence)
 *
 * (1)-(3) need `packages/codegen`'s `dist/cli.js` built (plain `tsc`, no
 * runtime dependency on `@ifc-lite/data` — the package imports it only
 * inside a generated-file TEMPLATE STRING, never at its own top level).
 * `buildCodegen()` below runs `pnpm --filter @ifc-lite/codegen... build`
 * unconditionally: on a tree the `build` CI job already built (this gate's
 * home, `node-tests`, downloads that artifact before running) it is a
 * turbo cache hit, well under a second; from clean it is ~7s. Failure to
 * build is a hard FAIL, not a skip — unlike `check-generated.mjs`'s
 * pre-push convenience, this is a required CI gate and an unbuildable
 * generator is itself news.
 *
 * (4) needs no build: `generate-ifc-schema.ts` / `emit-entity-names.ts` run
 * directly under the `tsx` loader already a workspace devDependency, the
 * same technique `packages/data/scripts/generate-ifc-schema.test.ts` uses
 * to run the generator against a throwaway copy of its own inputs.
 *
 * RUNTIME. Measured on this repo: `buildCodegen()` ~0.7s warm / ~7s cold,
 * (1)+(2) ~50ms each, (3) reuses (1)'s output (no extra generation), (4)
 * ~0.6s (parse + emit + entity-name pass). Comfortably under CI's per-step
 * budget with no caching needed; a hash-skip (input+generator digest ->
 * skip regeneration) was considered and dropped — nothing in this repo's
 * existing freshness gates (`check-generated.mjs`'s gates 2-7,
 * `check-sdk-canary-coverage.mjs`) skips on an input hash, they always run
 * when their preconditions (build artifacts / toolchain) are met, and at
 * these runtimes a skip would save nothing worth the extra state.
 *
 * DETERMINISM. `check-codegen-sync.test.mjs` runs the IFC4 generator twice
 * into two temp directories and asserts byte-identical output, and runs the
 * `diffDirs` comparison itself (the part that decides pass/fail) against
 * synthetic fixtures — corrupted, missing, and extra files — so a detector
 * that always reports "clean" cannot pass silently.
 *
 * FAILS CLOSED. A target whose generator throws, whose committed directory
 * does not exist, or whose file set differs in either direction (not just
 * content) is a named FAIL. Nothing here can report "clean" by finding
 * nothing to compare.
 *
 * @unwired-by-design-N/A — this script does not carry that marker: it is
 * wired into `.github/workflows/test.yml` (node-tests job) and
 * `package.json`'s `check:codegen-sync`. See PR description for merge
 * ordering relative to #3565 (this gate reports the drift #3565 fixes, so
 * it necessarily FAILS on `main` until #3565 merges — that is the point).
 *
 * Usage: node scripts/check-codegen-sync.mjs
 * Exit code: non-zero if any target's regeneration differs from committed.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/**
 * Every file under `dir`, at any depth, relative to `dir` and
 * POSIX-separated — mirrors `check-test-wiring.mjs`'s own recursive walk so
 * a target whose committed output grows a subdirectory is still compared in
 * full rather than silently truncated by a flat `readdirSync`.
 */
export function listFilesRecursive(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Byte-compare every file in `generatedDir` (freshly produced) against
 * `committedDir` (what's checked in). Returns `{ ok, missing, extra,
 * differing }`: `missing` = committed a generator no longer produces,
 * `extra` = generated but not committed, `differing` = present on both
 * sides with different bytes. All three are named failures; `ok` is true
 * only when all three are empty.
 */
export function diffDirs(generatedDir, committedDir) {
  if (!existsSync(committedDir)) {
    return { ok: false, missing: [], extra: [], differing: [], error: `committed directory does not exist: ${committedDir}` };
  }
  const generated = new Set(listFilesRecursive(generatedDir));
  const committed = new Set(listFilesRecursive(committedDir));
  const missing = [...committed].filter((f) => !generated.has(f)).sort();
  const extra = [...generated].filter((f) => !committed.has(f)).sort();
  const differing = [];
  for (const f of generated) {
    if (!committed.has(f)) continue;
    const a = readFileSync(join(generatedDir, f));
    const b = readFileSync(join(committedDir, f));
    if (!a.equals(b)) differing.push(f);
  }
  differing.sort();
  return { ok: missing.length === 0 && extra.length === 0 && differing.length === 0, missing, extra, differing };
}

/** Build `@ifc-lite/codegen` (and its workspace deps) so `dist/cli.js` exists. */
export function buildCodegen(root) {
  execFileSync('pnpm', ['--filter', '@ifc-lite/codegen...', 'build'], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

/** Run the built codegen CLI against `schemaPath`, writing into `outDir`. */
export function runCodegenCli(root, schemaPath, outDir) {
  const cliPath = join(root, 'packages/codegen/dist/cli.js');
  if (!existsSync(cliPath)) {
    throw new Error(`packages/codegen/dist/cli.js not found after build — cannot regenerate ${schemaPath}`);
  }
  execFileSync(process.execPath, [cliPath, schemaPath, '-o', outDir], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

/**
 * Run `packages/data`'s two-stage generator (`generate-ifc-schema.ts` then
 * `emit-entity-names.ts`, the second reading the first's output) against a
 * COPY of its scripts + vendored upstream `.cs` files, so nothing is ever
 * written into the repo tree. Mirrors the isolation technique
 * `generate-ifc-schema.test.ts` already uses for the same script.
 */
export function runDataGenerator(root, workDir) {
  const srcScripts = join(root, 'packages/data/scripts');
  const scriptsDir = join(workDir, 'scripts');
  const upstreamDir = join(scriptsDir, 'upstream');
  mkdirSync(upstreamDir, { recursive: true });
  mkdirSync(join(workDir, 'src/ifc-schema/generated'), { recursive: true });

  for (const name of ['generate-ifc-schema.ts', 'emit-entity-names.ts']) {
    writeFileSync(join(scriptsDir, name), readFileSync(join(srcScripts, name)));
  }
  for (const name of readdirSync(join(srcScripts, 'upstream')).filter((n) => n.endsWith('.g.cs'))) {
    writeFileSync(join(upstreamDir, name), readFileSync(join(srcScripts, 'upstream', name)));
  }

  const tsxLoader = require.resolve('tsx');
  for (const name of ['generate-ifc-schema.ts', 'emit-entity-names.ts']) {
    execFileSync(process.execPath, ['--import', tsxLoader, join(scriptsDir, name)], {
      cwd: workDir,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  }
  return join(workDir, 'src/ifc-schema/generated');
}

/** Run every target's generator + diff against `root`. Pure of process.exit. */
export function runAllTargets(root) {
  const results = [];
  let tmp;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'ifclite-codegen-sync-'));

    buildCodegen(root);

    const ifc4Out = join(tmp, 'ifc4');
    const ifc4x3Out = join(tmp, 'ifc4x3');
    runCodegenCli(root, join(root, 'packages/codegen/schemas/IFC4_ADD2_TC1.exp'), ifc4Out);
    runCodegenCli(root, join(root, 'packages/codegen/schemas/IFC4X3.exp'), ifc4x3Out);

    results.push({
      name: 'packages/codegen/generated/ifc4',
      ...diffDirs(ifc4Out, join(root, 'packages/codegen/generated/ifc4')),
    });
    results.push({
      name: 'packages/codegen/generated/ifc4x3',
      ...diffDirs(ifc4x3Out, join(root, 'packages/codegen/generated/ifc4x3')),
    });
    results.push({
      name: 'packages/parser/src/generated (mirrors codegen ifc4)',
      ...diffDirs(ifc4Out, join(root, 'packages/parser/src/generated')),
    });

    const dataOut = runDataGenerator(root, join(tmp, 'data'));
    results.push({
      name: 'packages/data/src/ifc-schema/generated',
      ...diffDirs(dataOut, join(root, 'packages/data/src/ifc-schema/generated')),
    });
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return results;
}

function printResult(r) {
  const icon = r.ok ? '✅' : '❌';
  console.log(`${icon} ${r.name}: ${r.ok ? 'PASS' : 'FAIL'}`);
  if (r.error) console.log(`   ${r.error}`);
  if (r.missing?.length) console.log(`   missing (committed, not regenerated): ${r.missing.join(', ')}`);
  if (r.extra?.length) console.log(`   extra (regenerated, not committed): ${r.extra.join(', ')}`);
  if (r.differing?.length) console.log(`   stale (content differs): ${r.differing.join(', ')}`);
}

// Only run as a CLI when invoked directly, not when imported by the test file.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  console.log('ifc-lite: checking committed codegen output against a fresh regeneration');
  console.log('─'.repeat(72));

  let results;
  try {
    results = runAllTargets(ROOT);
  } catch (e) {
    console.error(`❌ check-codegen-sync: regeneration failed — ${e.stdout || e.stderr || e.message}`);
    process.exit(1);
  }

  for (const r of results) printResult(r);

  const failed = results.filter((r) => !r.ok);
  console.log('─'.repeat(72));
  if (failed.length > 0) {
    console.log(
      `\n❌ ${failed.length} of ${results.length} generated-output target(s) are stale — regenerate and commit:\n` +
        '   pnpm --filter @ifc-lite/codegen... build\n' +
        '   pnpm --filter @ifc-lite/codegen run generate:ifc4\n' +
        '   pnpm --filter @ifc-lite/codegen run generate:ifc4x3\n' +
        '   (copy packages/codegen/generated/ifc4/* over packages/parser/src/generated/*)\n' +
        '   pnpm --filter @ifc-lite/data run generate:ifc-schema\n',
    );
    process.exit(1);
  }
  console.log(`\n✅ All ${results.length} generated-output targets match a fresh regeneration.`);
}
