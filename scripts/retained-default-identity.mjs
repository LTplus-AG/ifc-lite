#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// @unwired-by-design explicit release qualification, run under fleet admission
// Compare default distributed JS/WASM bytes using the canonical build script.
// Source exports are disposable; compiler output stays in the admitted cache.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const base = git('rev-parse', `${process.argv[2] ?? '853d7c9781'}^{commit}`);
const head = git('rev-parse', 'HEAD');
if (!process.env.IFC_WORKER_JOB_ID || !process.env.CARGO_TARGET_DIR) {
  throw new Error('Run through the fleet: an admitted job and managed Cargo target are required');
}
const directory = mkdtempSync(join(tmpdir(), 'ifc-retained-default-identity-'));
const source = join(directory, 'source');
const paths = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo', 'rust',
  'apps/server', 'scripts/build-wasm.sh', 'packages/wasm', 'LICENSE', 'README.md'];
const env = { ...process.env, CI: '1', BUILD_RETAINED: '', BUILD_THREADED: '',
  DEBUG_GEOMETRY: '', RUSTUP_TOOLCHAIN: 'nightly-2025-11-15' };
const report = { base, head, scope: 'default pkg JS/WASM/types/snippets; npm notices intentionally differ', builds: [] };
function inventory(path, prefix = '') {
  return readdirSync(join(path, prefix), { withFileTypes: true }).flatMap(entry => {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) return inventory(path, name);
    if (!/\.(?:wasm|js|mjs|ts)$/.test(name)) return [];
    const bytes = readFileSync(join(path, name));
    return [{ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
try {
  // Reuse the exact source path for both arms so filesystem paths embedded by
  // a compiler cannot manufacture a false difference. No source modifications.
  for (const commit of [base, head]) {
    mkdirSync(source);
    const archive = join(directory, 'source.tar');
    execFileSync('git', ['archive', '--format=tar', '--output', archive, commit, ...paths], { cwd: root });
    execFileSync('tar', ['-xf', archive, '-C', source]);
    rmSync(archive);
    const rustc = execFileSync('rustc', ['--version'], { cwd: source, env, encoding: 'utf8' }).trim();
    console.log(`DEFAULT_IDENTITY_BUILD ${JSON.stringify({ commit, rustc })}`);
    const result = spawnSync('bash', ['scripts/build-wasm.sh'], { cwd: source, env, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Default build ${commit} failed: ${result.status} ${result.signal ?? ''}`);
    const artifacts = inventory(join(source, 'packages/wasm/pkg'));
    if (!artifacts.some(file => file.path === 'ifc-lite_bg.wasm') || !artifacts.some(file => file.path === 'ifc-lite.js')) {
      throw new Error('Default build skipped the actual runtime');
    }
    report.builds.push({ commit, rustc, artifacts });
    console.log(`DEFAULT_IDENTITY_ARTIFACTS ${JSON.stringify(report.builds.at(-1))}`);
    rmSync(source, { recursive: true });
  }
  report.identical = JSON.stringify(report.builds[0].artifacts) === JSON.stringify(report.builds[1].artifacts);
  if (!report.identical) throw new Error('Default artifact bytes differ; inspect per-file hashes');
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
  writeFileSync(resolve(root, 'retained-package-proof-identity.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`DEFAULT_IDENTITY_RESULT ${JSON.stringify(report)}`);
}
