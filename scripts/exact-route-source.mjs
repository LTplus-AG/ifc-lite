/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, args, encoding = 'utf8') => execFileSync('git', ['-C', repo, ...args],
  { encoding, maxBuffer: 128 * 1024 * 1024 });
export function verifyHarnessManifest(manifest) {
  if (!manifest || manifest.protocol !== 'exact-route-v2' || !manifest.harness || Array.isArray(manifest.harness) ||
      !Object.keys(manifest.harness).length || !Array.isArray(manifest.overlay) || !manifest.overlay.length ||
      new Set(manifest.overlay).size !== manifest.overlay.length || !Array.isArray(manifest.fixtures) || !manifest.fixtures.length) {
    throw Error('incomplete harness manifest');
  }
  const pathOK = p => typeof p === 'string' && p.length && !p.startsWith('/') && !p.split('/').includes('..');
  for (const [path, sha] of Object.entries(manifest.harness)) {
    if (!pathOK(path) || !/^[a-f0-9]{64}$/.test(sha)) throw Error('invalid harness file/hash');
  }
  for (const path of manifest.overlay) if (!Object.hasOwn(manifest.harness, path)) throw Error('unpinned overlay');
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(manifest.harness).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  if (sha256(canonical) !== manifest.harnessSha256) throw Error('aggregate harness hash mismatch');
  for (const fixture of manifest.fixtures) if (!pathOK(fixture.path) || !/^[a-f0-9]{64}$/.test(fixture.sha256)) throw Error('invalid fixture pin');
  if (new Set(manifest.fixtures.map(f => f.path)).size !== manifest.fixtures.length) throw Error('duplicate fixture pin');
}
export function gitSource(repo, original, execution, manifest) {
  for (const commit of [original, execution]) {
    if (!/^[a-f0-9]{40}$/.test(commit) || git(repo, ['rev-parse', `${commit}^{commit}`]).trim() !== commit) {
      throw Error('source must be an independently resolved full Git commit');
    }
  }
  const originalTree = git(repo, ['rev-parse', `${original}^{tree}`]).trim();
  const executionTree = git(repo, ['rev-parse', `${execution}^{tree}`]).trim();
  const list = commit => git(repo, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean).map(row => {
    const [header, path] = row.split('\t');
    const [mode, type, oid] = header.split(' '); return { path, mode, type, oid };
  });
  const before = new Map(list(original).map(v => [v.path, v]));
  const after = new Map(list(execution).map(v => [v.path, v]));
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(path), b = after.get(path);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a || !b || !manifest.overlay.includes(path) || b.mode !== '100644' || b.type !== 'blob' ||
        sha256(git(repo, ['cat-file', 'blob', b.oid], null)) !== manifest.harness[path]) {
      throw Error(`execution commit differs beyond the exact added overlay: ${path}`);
    }
  }
  for (const path of manifest.overlay) {
    const file = after.get(path);
    if (!file || file.mode !== '100644' || sha256(git(repo, ['cat-file', 'blob', file.oid], null)) !== manifest.harness[path]) {
      throw Error(`execution overlay blob mismatch: ${path}`);
    }
  }
  const trackedSourceHashes = Object.fromEntries([...after.values()].filter(v =>
    ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'].includes(v.path) ||
    v.path.startsWith('.cargo/') || v.path.startsWith('rust/')).map(v => {
    if (v.type !== 'blob' || !['100644', '100755'].includes(v.mode)) throw Error(`unsupported source mode: ${v.path}`);
    return [v.path, sha256(git(repo, ['cat-file', 'blob', v.oid], null))];
  }));
  const toolchainInputs = Object.fromEntries(['Cargo.lock', 'rust-toolchain.toml', 'pnpm-lock.yaml', 'package.json'].map(path => {
    const file = after.get(path);
    if (!file || file.type !== 'blob') throw Error(`missing fleet toolchain input: ${path}`);
    return [path, sha256(git(repo, ['cat-file', 'blob', file.oid], null))];
  }));
  return { source: original, sourceTree: originalTree, executionCommit: execution, executionTree, trackedSourceHashes, toolchainInputs };
}
export function verifyWorktree(cwd, source) {
  if (git(cwd, ['rev-parse', 'HEAD']).trim() !== source.executionCommit || git(cwd, ['status', '--porcelain']).trim()) {
    throw Error('execution worktree must be clean and at its verified commit');
  }
  for (const [path, sha] of Object.entries(source.trackedSourceHashes)) {
    if (sha256(readFileSync(resolve(cwd, path))) !== sha) throw Error(`working bytes differ from Git blob: ${path}`);
  }
}
export function verifyFleet(path, outputPath, receiptPath, receipt, source) {
  // This external terminal receipt is supplied independently by the parent, not
  // selected by the capture receipt or accepted from a source-label assertion.
  const raw = readFileSync(path), fleet = JSON.parse(raw);
  if (fleet.state !== 'completed' || fleet.exitCode !== 0 || fleet.sourceUnchanged !== true ||
      typeof fleet.id !== 'string' || !fleet.id || !fleet.sourceBefore || !fleet.sourceAfter) throw Error('fleet run incomplete/failed');
  const toolchainInputs = fleet.sourceBefore.toolchainInputs;
  if (!toolchainInputs || typeof toolchainInputs !== 'object') throw Error('missing fleet toolchain inputs');
  for (const snapshot of [fleet.sourceBefore, fleet.sourceAfter]) {
    if (snapshot.commit !== source.executionCommit || snapshot.tree !== source.executionTree || snapshot.clean !== true ||
        snapshot.worktreeDigest !== sha256('') || !isDeepStrictEqual(snapshot, fleet.sourceBefore)) {
      throw Error('fleet source is not clean, unchanged and Git-bound');
    }
  }
  if (!isDeepStrictEqual(toolchainInputs, source.toolchainInputs)) throw Error('fleet toolchain blob mismatch');
  if (fleet.tools?.rustc?.exitCode !== 0 || fleet.tools?.cargo?.exitCode !== 0 ||
      fleet.tools.rustc.version !== receipt.toolchain.split('\n')[0] || fleet.tools.cargo.version !== receipt.cargo) throw Error('fleet compiler identity mismatch');
  if (resolve(fleet.cwd) !== resolve(receipt.cwd)) throw Error('fleet/capture cwd mismatch');
  const output = readFileSync(outputPath);
  if (fleet.outputSha256 !== sha256(output)) throw Error('fleet output log hash mismatch');
  const marker = `EXACT_ROUTE_RECEIPT_SHA256 ${sha256(readFileSync(receiptPath))}`;
  const markers = output.toString().split(/\r?\n/).filter(line => line.startsWith('EXACT_ROUTE_RECEIPT_SHA256 '));
  if (markers.length !== 1 || markers[0] !== marker) throw Error('fleet output does not bind the actual capture receipt bytes');
  const expected = receipt.requestedCommand;
  if (!Array.isArray(expected) || !Array.isArray(fleet.command) || expected.length < 6 ||
      JSON.stringify(fleet.command.slice(-expected.length)) !== JSON.stringify(expected)) throw Error('fleet command does not bind capture invocation');
  return { id: fleet.id, receiptSha256: sha256(raw), outputSha256: sha256(output) };
}
