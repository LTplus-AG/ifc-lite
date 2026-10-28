/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// #8042: assert the built artifact contract, not source text. Root turbo test
// builds first; a missing dist is a failure, never silently skipped coverage.
test('published diff contains only Rust adapters and public declarations (#8042)', () => {
  const files = readdirSync(new URL('../dist/', import.meta.url), { recursive: true });
  const modules = files.filter((file): file is string => typeof file === 'string' && file.endsWith('.js'));
  expect(modules.sort()).toEqual([
    'content-match-types.js', 'diff-options.js', 'fingerprint.js', 'identity-map.js',
    'identity-sidecar.js', 'index.js', 'internal.js', 'lineage-sidecar.js', 'lineage.js', 'prepared-model.js',
    'sidecar-common.js', 'split-merge-types.js', 'successor-types.js', 'types.js',
    'wasm-binary.js', 'wasm-columns.js', 'wasm-diff.js', 'wasm-fingerprint.js', 'wasm-identity-sidecar.js',
    'wasm-lineage-sidecar.js', 'wasm-lineage.js', 'wasm-projections.js',
    'wasm-provenance.js', 'wasm-result.js', 'wasm-runtime.js', 'wasm-sidecar.js',
  ].sort());
  expect(files.some(file => /(?:oracle|\.test\.)/.test(String(file)))).toBe(false);
});

// Retaining a familiar file name must not leave its old engine callable.
test('former engine modules expose declarations and provenance constants only (#8042)', async () => {
  for (const name of [
    'fingerprint', 'identity-sidecar', 'lineage', 'lineage-sidecar', 'sidecar-common',
    'types', 'diff-options', 'content-match-types', 'split-merge-types', 'successor-types',
  ]) {
    const declarations: Record<string, unknown> = await import(new URL(`../dist/${name}.js`, import.meta.url).href);
    expect(Object.keys(declarations), name).toEqual([]);
  }
  const provenance: Record<string, unknown> = await import(new URL('../dist/identity-map.js', import.meta.url).href);
  expect({ ...provenance }).toEqual({
    CONTENT_MATCH_REASON_PREFIX: 'content-match:',
    SUCCESSOR_REASON_PREFIX: 'successor:',
    ACCEPTED_AMBIGUOUS_REASON: 'accepted:ambiguous',
  });
});

// Both entry points must share the same explicit owner, rather than allocating
// incompatible handles or shipping a second implementation (#8042 A1).
test('published root and internal entry share the handle API (#8042)', async () => {
  const root: typeof import('../src/index.js') = await import(new URL('../dist/index.js', import.meta.url).href);
  const internal: typeof import('../src/internal.js') = await import(new URL('../dist/internal.js', import.meta.url).href);
  expect(typeof root.DiffModelHandle).toBe('function');
  expect(root.DiffModelHandle).toBe(internal.DiffModelHandle);
  expect(root.prepareDiffModel).toBe(internal.prepareDiffModel);
  expect(typeof root.DiffModelHandle.prototype[Symbol.dispose]).toBe('function');
});

// The handle module was already an internal shipped adapter. Promoting it
// must keep the tarball inventory identical to the deliberate dist inventory.
test('diff tarball ships the public handle module and declarations without test or oracle files (#8042)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ifc-diff-handle-pack-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', scratch], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'pipe',
    });
    const archive = readdirSync(scratch).find(name => name.endsWith('.tgz'));
    expect(archive).toBeDefined();
    const inventory = execFileSync('tar', ['-tf', join(scratch, archive!)], { encoding: 'utf8' }).trim().split('\n');
    expect(inventory).toContain('package/dist/prepared-model.js');
    expect(inventory).toContain('package/dist/prepared-model.d.ts');
    expect(inventory.some(name => /(?:oracle|\.test\.)/.test(name))).toBe(false);
    const packedJs = inventory.filter(name => name.startsWith('package/dist/') && name.endsWith('.js'))
      .map(name => name.slice('package/dist/'.length)).sort();
    const builtJs = readdirSync(new URL('../dist/', import.meta.url)).filter(name => name.endsWith('.js')).sort();
    expect(packedJs).toEqual(builtJs);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
