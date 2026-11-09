/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
const binary = new URL('../../wasm/pkg-diff/ifc-lite-diff_bg.wasm', import.meta.url);
const glue = new URL('../../wasm/pkg-diff/ifc-lite-diff.js', import.meta.url);
test.skipIf(!existsSync(binary) || !existsSync(glue))('sparse fingerprint collections match the actual WASM oracle (#8042)', () => {
  const child = spawnSync(process.execPath, [
    fileURLToPath(new URL('../test/wasm-fingerprint-sparse.mjs', import.meta.url)),
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 });
  const diagnostic = JSON.stringify({ error: child.error?.message, status: child.status,
    signal: child.signal, stdout: child.stdout, stderr: child.stderr });
  expect(child.error, diagnostic).toBeUndefined();
  expect(child.signal, diagnostic).toBeNull();
  expect(child.status, diagnostic).toBe(0);
  expect(child.stderr, diagnostic).toBe('');
  expect(JSON.parse(child.stdout)).toEqual({ protocol: 'wasm-fingerprint-sparse-8042', comparisons: 90 });
});
