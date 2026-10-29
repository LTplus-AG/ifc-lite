/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readdirSync } from 'node:fs';
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
