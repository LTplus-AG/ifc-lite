/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from './diff-e2e-protocol.mjs';

export async function fileReceipt(path, maxBytes = LIMITS.fixtureBytes) {
  const info = await stat(path);
  assert.ok(info.isFile() && info.size > 0 && info.size <= maxBytes, `${path}: empty or oversized`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    assert.ok(bytes <= maxBytes, `${path}: grew beyond bound`);
    hash.update(chunk);
  }
  assert.equal(bytes, info.size, `${path}: changed during hashing`);
  return { path: await realpath(path), bytes, sha256: hash.digest('hex') };
}

export async function readJson(path, maxBytes = 1024 * 1024) {
  const receipt = await fileReceipt(path, maxBytes);
  const text = await readFile(path, 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), receipt.sha256);
  return { value: JSON.parse(text), receipt };
}

export function sourceReceipt(root) {
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  assert.equal(git(['status', '--porcelain', '--untracked-files=normal']), '', `${root}: source must be clean`);
  return { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) };
}

export async function inventory(root, implementation, runtimePaths = []) {
  root = await realpath(root);
  const artifacts = {};
  const required = ['packages/cli/dist/loader.js', 'packages/cli/dist/commands/diff-engine.js',
    'packages/diff/dist/index.js', 'pnpm-lock.yaml', 'package.json'];
  if (implementation === 'rust-wasm') required.push('packages/diff/dist/wasm-runtime.js',
    'packages/diff/dist/wasm-columns.js', 'packages/diff/dist/wasm-result.js',
    'packages/wasm/pkg-diff/ifc-lite-diff.js', 'packages/wasm/pkg-diff/ifc-lite-diff_bg.wasm');
  for (const path of required) artifacts[path] = await fileReceipt(resolve(root, path));
  // Hash ALL built workspace dependencies, not only the diff entry point.
  // node_modules installation provenance remains the preparation receipt's job.
  let files = 0;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:m?js|cjs|json|wasm)$/.test(entry.name)) {
        assert.ok(++files <= 30_000, 'artifact inventory file bound');
        artifacts[relative(root, path)] = await fileReceipt(path);
      }
    }
  }
  for (const pkg of await readdir(resolve(root, 'packages'))) {
    const dir = resolve(root, 'packages', pkg, 'dist');
    try { await stat(dir); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await walk(dir);
  }
  for (const name of ['pkg', 'pkg-retained', 'pkg-diff']) {
    const dir = resolve(root, 'packages/wasm', name);
    try { await stat(dir); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await walk(dir);
  }
  const dependencies = {};
  assert.ok(runtimePaths.length > 0 && runtimePaths.length <= 30_000, 'runtime dependency inventory required');
  for (const path of [...new Set(runtimePaths)].sort()) {
    const receipt = await fileReceipt(path);
    dependencies[receipt.path] = receipt;
    // Bind package metadata as well as loaded bytes (exports/type/version).
    let dir = dirname(receipt.path);
    while (dir !== dirname(dir)) {
      const manifest = resolve(dir, 'package.json');
      try { dependencies[manifest] = await fileReceipt(manifest); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      dir = dirname(dir);
    }
  }
  return { root, implementation, runtime: await runtimeReceipt(), source: sourceReceipt(root), artifacts, dependencies };
}

export async function harnessReceipt() {
  const dir = fileURLToPath(new URL('./', import.meta.url));
  const paths = ['diff-e2e.mjs', 'diff-e2e-sample.mjs', 'diff-e2e-protocol.mjs',
    'diff-e2e-receipts.mjs', 'diff-e2e-resolve.mjs', 'diff-e2e-require.cjs', 'ab-order.mjs', '../lib/is-main-entry.mjs'];
  return Object.fromEntries(await Promise.all(paths.map(async p => [p, await fileReceipt(resolve(dir, p))])));
}

// A normalized attestation links an immutable original scheduler receipt, not
// just arbitrary bytes named build.json. The trusted preparer must inspect the
// original outcome and attest a cache-free rebuild of these exact outputs.
export function validateBuildReceipt(build, inv, original, execution, manifest, manifestReceipt) {
  assert.equal(execution.state, 'completed', 'original scheduler execution must have completed');
  assert.equal(execution.exitCode, 0, 'original scheduler build must succeed');
  assert.equal(execution.sourceUnchanged, true);
  assert.deepEqual(execution.sourceBefore, execution.sourceAfter, 'build changed source');
  assert.equal(execution.cwd, inv.root);
  assert.deepEqual(build.workerCommand, execution.command, 'original build command mismatch');
  assert.ok(Array.isArray(execution.command) && execution.command.length > 0);
  assert.equal(execution.sourceAfter.clean, true);
  for (const key of ['commit', 'tree']) assert.equal(execution.sourceAfter[key], inv.source[key]);
  assert.equal(execution.sourceAfter.toolchainInputs['pnpm-lock.yaml'], inv.artifacts['pnpm-lock.yaml'].sha256, 'build lockfile mismatch');
  assert.ok(Object.values(execution.artifacts).includes(manifestReceipt.sha256),
    'output manifest must be an artifact SHA256 recorded by the original successful worker');
  assert.deepEqual(build.outputManifestReceipt, manifestReceipt);
  const attested = Object.fromEntries(Object.entries(build).filter(([key]) => !['originalReceipt', 'outputManifestReceipt'].includes(key)));
  assert.deepEqual(attested, manifest, 'build attestation differs from scheduler-published output manifest');
  assert.equal(build.version, 'ifc-diff-build/1');
  assert.equal(build.status, 'succeeded');
  assert.equal(build.exitCode, 0);
  assert.equal(build.freshOutputs, true, 'remove generated outputs and rebuild; unchanged bytes do not prove freshness');
  assert.deepEqual(build.source, inv.source, 'build source mismatch');
  assert.equal(build.root, inv.root);
  assert.equal(build.implementation, inv.implementation);
  assert.deepEqual(build.runtime, inv.runtime);
  assert.deepEqual(build.originalReceipt, original, 'original build receipt mismatch');
  assert.ok(Array.isArray(build.commands) && build.commands.length > 0 && build.commands.every(c =>
    typeof c === 'string' && c.trim()), 'exact successful build commands required');
  assert.ok(typeof build.toolchain === 'string' && build.toolchain.trim(), 'toolchain receipt required');
  const start = Date.parse(build.startedAt), end = Date.parse(build.finishedAt);
  assert.ok(Number.isFinite(start) && end >= start && end <= Date.now(), 'invalid build times');
  assert.deepEqual(build.outputs, inv.artifacts, 'build output SHA256s must reconcile with inventory');
  assert.deepEqual(build.dependencies, inv.dependencies, 'resolved dependency SHA256s must reconcile with inventory');
}

export async function validateResolved(paths, inv, harness) {
  assert.ok(paths.length > 0 && paths.length <= 30_000, 'actual runtime resolution missing/oversized');
  const allowed = new Map([...Object.values(inv.artifacts), ...Object.values(inv.dependencies),
    ...Object.values(harness)].map(r => [r.path, r]));
  for (const path of new Set(paths)) {
    const actual = await fileReceipt(path);
    assert.deepEqual(actual, allowed.get(actual.path), `unprepared runtime dependency: ${path}`);
  }
}

export async function runtimeReceipt() {
  return { node: process.version, execPath: process.execPath,
    executable: await fileReceipt(process.execPath) };
}
