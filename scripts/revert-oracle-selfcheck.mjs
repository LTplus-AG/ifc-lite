#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { REVERT_ORACLE_ADAPTERS } from './lib/revert-oracle-adapters.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE = join(ROOT, 'scripts/check-test-revert-oracle.mjs');
export const EXPECTED_PROBES = Object.freeze({
  observed: Object.freeze(['OBSERVED']),
  unobserved: Object.freeze(['UNOBSERVED']),
  notExecuting: Object.freeze(['BASELINE-BROKEN', 'INCONCLUSIVE']),
});

export function validateSelfcheckResult(adapterId, mode, actual, expected = EXPECTED_PROBES) {
  const wanted = expected[mode];
  if (wanted.includes(actual.verdict)) return null;
  return `adapter ${adapterId} ${mode} probe: expected ${wanted.join(' or ')}, got ${actual.verdict}`;
}

function resolveBinary(adapter) {
  if (adapter.binary === 'node') return { bin: process.execPath, prefix: [] };
  if (adapter.binary === 'python3' && process.platform === 'win32') {
    const probe = spawnSync('py', ['-3', '--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? null : { bin: 'py', prefix: ['-3'] };
  }
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

function jsSource(mode, importPath, vitest = false) {
  const imports = vitest
    ? "import { test, expect } from 'vitest';"
    : "import test from 'node:test';\nimport assert from 'node:assert/strict';";
  if (mode === 'notExecuting') return `${imports}\ntest.skip('intentionally skipped', () => {});\n`;
  const assertion = mode === 'observed'
    ? vitest ? 'expect(value).toBe(1)' : 'assert.equal(value, 1)'
    : vitest ? 'expect(1).toBe(1)' : 'assert.equal(1, 1)';
  return `${imports}\nimport { value } from '${importPath}';\ntest('probe', () => ${assertion});\n`;
}

function pythonSource(mode) {
  if (mode === 'notExecuting') return 'import pytest\n\n@pytest.mark.skip(reason="intentional")\ndef test_probe():\n    pass\n';
  return mode === 'observed'
    ? 'from value import value\n\ndef test_probe():\n    assert value == 1\n'
    : 'def test_probe():\n    assert 1 == 1\n';
}

function rustSource(mode) {
  const ignored = mode === 'notExecuting' ? '#[ignore]\n' : '';
  const assertion = mode === 'observed' ? 'assert_eq!(revert_oracle_selfcheck::value(), 1)' : 'assert_eq!(1, 1)';
  return `${ignored}#[test]\nfn probe() { ${assertion}; }\n`;
}

function buildFixture(adapter, mode, dir) {
  let production;
  let testFile;
  if (adapter.id === 'python-pytest') {
    writeFileSync(join(dir, 'requirements.txt'), 'pytest\n');
    production = 'value.py'; testFile = 'test_probe.py';
    writeFileSync(join(dir, testFile), pythonSource(mode));
  } else if (adapter.id === 'cargo') {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="revert-oracle-selfcheck"\nversion="0.0.0"\nedition="2021"\n');
    production = 'src/lib.rs'; testFile = 'tests/probe.rs';
    writeFileSync(join(dir, testFile), rustSource(mode));
  } else if (adapter.id === 'typescript') {
    mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'pkg/src'), { recursive: true });
    copyFileSync(join(ROOT, 'scripts/typecheck-tests.mjs'), join(dir, 'scripts/typecheck-tests.mjs'));
    copyFileSync(join(ROOT, 'tsconfig.tests.base.json'), join(dir, 'tsconfig.tests.base.json'));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
    writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
    writeFileSync(join(dir, 'pkg/package.json'), '{"private":true}\n');
    writeFileSync(join(dir, 'pkg/tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src/**/*'] }));
    production = 'pkg/src/value.ts'; testFile = 'pkg/src/probe.test.ts';
    writeFileSync(join(dir, testFile), mode === 'observed'
      ? "import type { Value } from './value';\nconst probe: Value['marker'] = 1;\nvoid probe;\n"
      : mode === 'notExecuting' ? 'const probe: never = 1;\nvoid probe;\n' : 'const probe: 1 = 1;\nvoid probe;\n');
  } else {
    const nested = adapter.id === 'root-node-test' ? '' : 'pkg';
    const base = nested ? join(dir, nested) : dir;
    mkdirSync(join(base, 'src'), { recursive: true });
    if (nested) writeFileSync(join(base, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: adapter.id === 'vitest' ? 'vitest run' : 'node --test' } }));
    else writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'turbo test' } }));
    if (adapter.id === 'vitest') {
      const binary = resolveBinary(adapter);
      if (!binary) throw new Error('lost runner vitest: vitest is unavailable');
      const modules = dirname(dirname(binary.prefix[0]));
      symlinkSync(modules, join(base, 'node_modules'), 'junction');
    }
    production = nested ? `${nested}/src/value.mjs` : 'src/value.mjs';
    testFile = nested ? `${nested}/src/probe.test.mjs` : 'scripts/probe.test.mjs';
    if (!nested) mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, testFile), jsSource(mode, './value.mjs'.replace('./', nested ? './' : '../src/'), adapter.id === 'vitest'));
  }
  const head = adapter.id === 'typescript' ? 'export interface Value { marker: 1 }\n'
    : adapter.id === 'cargo' ? 'pub fn value() -> u32 { 1 }\n'
    : adapter.id === 'python-pytest' ? 'value = 1\n' : 'export const value = 1;\n';
  const reverted = adapter.id === 'typescript' ? 'export interface Value {}\n'
    : adapter.id === 'cargo' ? 'pub fn value() -> u32 { 0 }\n'
    : adapter.id === 'python-pytest' ? 'value = 0\n' : 'export const value = 0;\n';
  writeFileSync(join(dir, production), head);
  return { production, testFile, head, reverted };
}

function runProbe(adapter, mode) {
  if (!resolveBinary(adapter)) throw new Error(`lost runner ${adapter.id}: ${adapter.binary} is unavailable`);
  const dir = mkdtempSync(join(tmpdir(), `revert-oracle-${adapter.id}-`));
  const run = (bin, args, expected = 0) => {
    const result = spawnSync(bin, args, {
      cwd: dir, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', CARGO_TARGET_DIR: join(dir, 'target') },
    });
    if (result.error) throw new Error(`${bin} failed: ${result.error.message}`);
    if (result.status !== expected) throw new Error(`${bin} ${args.join(' ')} exited ${result.status}, expected ${expected}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  try {
    const fixture = buildFixture(adapter, mode, dir);
    const testSource = readFileSync(join(dir, fixture.testFile), 'utf8');
    writeFileSync(join(dir, '.gitignore'), 'node_modules\ntarget\n.pytest_cache\ntsconfig.tests.json\n');
    writeFileSync(join(dir, fixture.production), fixture.reverted);
    rmSync(join(dir, fixture.testFile));
    run('git', ['init', '-q']);
    run('git', ['config', 'core.autocrlf', 'false']);
    run('git', ['config', 'user.name', 'Revert oracle selfcheck']);
    run('git', ['config', 'user.email', 'oracle@example.invalid']);
    if (adapter.id === 'cargo') run('cargo', ['generate-lockfile', '--offline']);
    run('git', ['add', '.']); run('git', ['commit', '-qm', 'base']);
    const base = run('git', ['rev-parse', 'HEAD']).stdout.trim();
    writeFileSync(join(dir, fixture.production), fixture.reverted);
    writeFileSync(join(dir, fixture.production), fixture.head);
    writeFileSync(join(dir, fixture.testFile), testSource);
    run('git', ['add', '.']); run('git', ['commit', '-qm', 'head']);
    const expectedExit = mode === 'observed' ? 0 : mode === 'unobserved' ? 1 : 3;
    const measured = run(process.execPath, [ORACLE, '--root', dir, '--base', base, '--ci', '--json'], expectedExit);
    const jsonStart = measured.stdout.indexOf('{');
    if (jsonStart < 0) throw new Error(`adapter ${adapter.id} emitted no JSON result`);
    const result = JSON.parse(measured.stdout.slice(jsonStart));
    if (result.restoration !== 'verified') throw new Error(`adapter ${adapter.id} did not verify restoration`);
    if (readFileSync(join(dir, fixture.production), 'utf8') !== fixture.head) throw new Error(`adapter ${adapter.id} fixture did not restore`);
    if (run('git', ['status', '--porcelain']).stdout.trim() !== '') throw new Error(`adapter ${adapter.id} left a dirty fixture`);
    return result;
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
      console.log(`[selfcheck] ${adapter.id} ${mode}: ${actual.verdict}${actual.reason ? ` — ${actual.reason}` : ''}`);
      if (failure) failures.push(failure);
    }
  }
  if (failures.length > 0) throw new Error(`revert-oracle selfcheck failed:\n${failures.join('\n')}`);
  console.log(`[selfcheck] all ${selected.length} selected adapter(s) passed all three probes`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
