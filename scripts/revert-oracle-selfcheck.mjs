#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { REVERT_ORACLE_ADAPTERS } from './lib/revert-oracle-adapters.mjs';
import { parseRunnerOutput } from './lib/revert-oracle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXPECTED_PROBES = Object.freeze({
  observed: Object.freeze(['assertion-failure']),
  unobserved: Object.freeze(['pass']),
  notExecuting: Object.freeze(['no-tests', 'all-skipped']),
});

export function validateSelfcheckResult(adapterId, mode, actual, expected = EXPECTED_PROBES) {
  const wanted = expected[mode];
  if (wanted.includes(actual.kind)) return null;
  return `adapter ${adapterId} ${mode} probe: expected ${wanted.join(' or ')}, got ${actual.kind}`;
}

function resolveBinary(adapter) {
  if (adapter.binary === 'node') return { bin: process.execPath, prefix: [] };
  if (adapter.binary === 'vitest') {
    for (const parent of ['packages', 'apps']) {
      for (const name of readdirSync(join(ROOT, parent))) {
        const module = join(ROOT, parent, name, 'node_modules', 'vitest', 'vitest.mjs');
        if (existsSync(module)) return { bin: process.execPath, prefix: [module] };
      }
    }
    return null;
  }
  const probe = spawnSync(adapter.binary, ['--version'], { encoding: 'utf8' });
  return probe.error || probe.status !== 0 ? null : { bin: adapter.binary, prefix: [] };
}

function jsSource(mode) {
  if (mode === 'notExecuting') return "import { test } from 'node:test';\ntest.skip('intentionally skipped', () => {});\n";
  const expected = mode === 'observed' ? 2 : 1;
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('probe', () => assert.equal(1, ${expected}));\n`;
}

function vitestSource(mode) {
  if (mode === 'notExecuting') return "test.skip('intentionally skipped', () => {});\n";
  const expected = mode === 'observed' ? 2 : 1;
  return `test('probe', () => expect(1).toBe(${expected}));\n`;
}

function pythonSource(mode) {
  if (mode === 'notExecuting') return 'import pytest\n\n@pytest.mark.skip(reason="intentional")\ndef test_probe():\n    pass\n';
  const expected = mode === 'observed' ? 2 : 1;
  return `def test_probe():\n    assert 1 == ${expected}\n`;
}

function rustSource(mode) {
  const ignored = mode === 'notExecuting' ? '#[ignore]\n' : '';
  const expected = mode === 'observed' ? 2 : 1;
  return `${ignored}#[test]\nfn probe() { assert_eq!(1, ${expected}); }\n`;
}

function probeCommand(adapter, mode, dir) {
  const file = join(dir, 'probe.test.mjs');
  if (adapter.id === 'root-node-test' || adapter.id === 'node-test') {
    writeFileSync(file, jsSource(mode));
    return { cwd: dir, runner: adapter.probeRunner({ file, dir, root: ROOT }) };
  }
  if (adapter.id === 'vitest') {
    const spec = join(dir, 'probe.test.js');
    writeFileSync(spec, vitestSource(mode));
    return { cwd: dir, runner: adapter.probeRunner({ file: spec, dir, root: ROOT }) };
  }
  if (adapter.id === 'python-pytest') {
    const testFile = join(dir, 'test_probe.py');
    writeFileSync(testFile, pythonSource(mode));
    return { cwd: dir, runner: adapter.probeRunner({ file: testFile, dir, root: ROOT }) };
  }
  if (adapter.id === 'cargo') {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="revert-oracle-selfcheck"\nversion="0.0.0"\nedition="2021"\n');
    writeFileSync(join(dir, 'src/lib.rs'), 'pub fn marker() {}\n');
    writeFileSync(join(dir, 'tests/probe.rs'), rustSource(mode));
    return { cwd: dir, runner: adapter.probeRunner({ dir, root: ROOT }) };
  }
  if (adapter.id === 'typescript') {
    const source = mode === 'observed' ? 'const value: 1 = 2;\n' : 'const value: 1 = 1;\n';
    if (mode !== 'notExecuting') writeFileSync(join(dir, 'probe.ts'), source);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true }, files: mode === 'notExecuting' ? [] : ['probe.ts'] }));
    return { cwd: dir, runner: adapter.probeRunner({ dir, root: ROOT }) };
  }
  throw new Error(`adapter ${adapter.id} has no selfcheck probe`);
}

function runProbe(adapter, mode) {
  const binary = resolveBinary(adapter);
  if (!binary) throw new Error(`lost runner ${adapter.id}: ${adapter.binary} is unavailable`);
  const dir = mkdtempSync(join(tmpdir(), `revert-oracle-${adapter.id}-`));
  try {
    const { cwd, runner } = probeCommand(adapter, mode, dir);
    const run = spawnSync(binary.bin, [...binary.prefix, ...runner.args], {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', CARGO_TARGET_DIR: join(dir, 'target') },
    });
    if (run.error) throw new Error(`lost runner ${adapter.id}: ${run.error.message}`);
    if (runner.family === 'typecheck') {
      const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
      if (/TS18002/.test(output)) return { kind: 'no-tests' };
      return { kind: run.status === 0 ? 'pass' : 'assertion-failure' };
    }
    return parseRunnerOutput({ family: runner.family, stdout: run.stdout ?? '', stderr: run.stderr ?? '', exitCode: run.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function validateAdapterManifest(adapters = REVERT_ORACLE_ADAPTERS) {
  const ids = new Set();
  for (const adapter of adapters) {
    if (!adapter.id || !adapter.family || !adapter.binary || typeof adapter.claim !== 'function' || typeof adapter.runner !== 'function' || typeof adapter.probeRunner !== 'function') {
      throw new Error('every revert-oracle adapter needs id, family, binary, claim, runner and probeRunner');
    }
    if (ids.has(adapter.id)) throw new Error(`duplicate revert-oracle adapter id: ${adapter.id}`);
    ids.add(adapter.id);
  }
}

export function main(argv = process.argv.slice(2)) {
  validateAdapterManifest();
  const adapterFlag = argv.indexOf('--adapter');
  const selected = adapterFlag === -1
    ? REVERT_ORACLE_ADAPTERS
    : REVERT_ORACLE_ADAPTERS.filter((adapter) => adapter.id === argv[adapterFlag + 1]);
  if (selected.length === 0) throw new Error(`unknown selfcheck adapter: ${argv[adapterFlag + 1] ?? '(missing)'}`);
  const failures = [];
  for (const adapter of selected) {
    for (const mode of Object.keys(EXPECTED_PROBES)) {
      const actual = runProbe(adapter, mode);
      const failure = validateSelfcheckResult(adapter.id, mode, actual);
      console.log(`[selfcheck] ${adapter.id} ${mode}: ${actual.kind}`);
      if (failure) failures.push(failure);
    }
  }
  if (failures.length > 0) throw new Error(`revert-oracle selfcheck failed:\n${failures.join('\n')}`);
  console.log(`[selfcheck] all ${selected.length} selected adapter(s) passed all three probes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
