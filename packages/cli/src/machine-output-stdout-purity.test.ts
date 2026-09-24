/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `docs/guide/cli.md` states the contract: **stdout = data**. A command that
 * emits `--json` (or, for `gym`, newline-delimited JSON) must put nothing else
 * there.
 *
 * It regressed because the parser and the wasm geometry module print through
 * `console.log`, which in Node IS stdout. Every command that drives geometry
 * must therefore call `routeConsoleDiagnosticsToStderr()` BEFORE the first
 * parse/geometry init -- the wasm module captures its print bindings at init
 * time, so a later call is too late. `clash` did; `simplify`, `lod`,
 * `extract-entities` and `gym` did not, and each emitted ~25 lines of
 * `[IFC-LITE] Opening classifier: …` ahead of its payload while still exiting 0.
 *
 * HOW THIS OBSERVES THE FIX, and the two ways an earlier revision did not.
 *
 * The diagnostics come from the wasm geometry module, which only prints them in
 * a real run of the built binary -- importing the command functions in-process
 * produces no console output at all, so an in-process spy observes nothing
 * either way. So this spawns.
 *
 * But spawning `dist/index.js` as it happens to be on disk is also vacuous: the
 * revert oracle reverts SOURCE, and a `dist/` built before the revert still
 * contains the fix, so the test passes before and after. (An even earlier
 * revision skipped outright when `dist/` was absent, which is vacuous in a
 * third way.) Hence the `beforeAll` rebuild: the binary under test is always
 * compiled from the source in the working tree.
 *
 * Coverage is honest about itself: reverting all four calls makes `simplify`
 * fail here, which is what proves the suite observes the change. Whether the
 * other three also leak depends on how much of the geometry pass that machine's
 * wasm build reaches, so they may pass vacuously in some environments. They are
 * still the contract each command owes, and they cost one spawn each.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const CLI = join(PKG_ROOT, 'dist', 'index.js');
// Committed viewer demo sample, so this never needs `pnpm fixtures`. It has
// real openings, which is what makes the geometry pass emit diagnostics at all.
const SAMPLE_IFC = resolve(PKG_ROOT, '../../apps/viewer/public/samples/building-architecture.ifc');

/** Compiling the package plus a full geometry pass is well past vitest's 5 s. */
const CASE_TIMEOUT_MS = 300_000;

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'ifc-lite-stdout-'));
  // Compile from the working tree, so the binary under test is this source and
  // not whatever `dist/` happened to be left behind by an earlier build.
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', PKG_ROOT], { stdio: 'pipe', timeout: CASE_TIMEOUT_MS });
}, CASE_TIMEOUT_MS);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function runCli(args: string[], stdin = '') {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    input: stdin,
    timeout: CASE_TIMEOUT_MS,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

describe('machine-readable stdout carries only the payload', () => {
  it('simplify --json emits one JSON document', () => {
    const { stdout, status } = runCli([
      'simplify', SAMPLE_IFC, '--out', join(outDir, 's.ifc'), '--level', '3', '--json',
    ]);
    expect(status).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  }, CASE_TIMEOUT_MS);

  it('lod --level 1 --json emits one JSON document', () => {
    const { stdout, status } = runCli([
      'lod', SAMPLE_IFC, '--level', '1', '--out', join(outDir, 'm.glb'), '--json',
    ]);
    expect(status).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  }, CASE_TIMEOUT_MS);

  it('extract-entities --detect --report --json emits one JSON document', () => {
    const { stdout, status } = runCli([
      'extract-entities', SAMPLE_IFC, '--detect', '--report', '--json',
    ]);
    expect(status).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  }, CASE_TIMEOUT_MS);

  it('gym emits newline-delimited JSON with no bare diagnostic lines', () => {
    const { stdout, status } = runCli(
      ['gym', '--model', SAMPLE_IFC, '--checks', 'schema,clash'],
      '{"type":"close"}\n',
    );
    expect(status).toBe(0);
    const lines = stdout.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line), `not JSON: ${line.slice(0, 80)}`).not.toThrow();
    }
  }, CASE_TIMEOUT_MS);
});
