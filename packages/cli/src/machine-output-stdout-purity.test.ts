/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `docs/guide/cli.md` states the contract: **stdout = data**. A command that
 * emits `--json` (or, for `gym`, newline-delimited JSON) must therefore put
 * NOTHING else there.
 *
 * It regressed because the parser and the wasm geometry module print
 * diagnostics through `console.log`, which is stdout in Node. Every command
 * that drives geometry must call `routeConsoleDiagnosticsToStderr()` before the
 * first parse/geometry init; `clash` did and `simplify`, `lod`,
 * `extract-entities` and `gym` did not, so their machine output arrived with
 * ~25 lines of `[IFC-LITE] Opening classifier: …` in front of it and
 * `JSON.parse` failed on character 1 — while the exit code stayed 0.
 *
 * This runs the real binary rather than asserting the call is present, because
 * the ordering (before geometry init) is the load-bearing half and only a run
 * can check it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const CLI = join(PKG_ROOT, 'dist', 'index.js');
// Committed viewer demo sample, so this never needs `pnpm fixtures`. It carries
// real openings, which is what makes the geometry pass print diagnostics at all.
const SAMPLE_IFC = resolve(PKG_ROOT, '../../apps/viewer/public/samples/building-architecture.ifc');

/** Each case runs a full geometry pass on a real model, so the default 5s is not enough. */
const CASE_TIMEOUT_MS = 300_000;

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'ifc-lite-stdout-'));
  return () => rmSync(outDir, { recursive: true, force: true });
});

function runCli(args: string[], stdin = '') {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    input: stdin,
    timeout: CASE_TIMEOUT_MS,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

const describeIfBuilt = existsSync(CLI) && existsSync(SAMPLE_IFC) ? describe : describe.skip;

describeIfBuilt('machine-readable stdout carries only the payload', () => {
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
