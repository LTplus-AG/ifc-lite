// SPDX-License-Identifier: MPL-2.0
// Canonical public JS API + actual SDK Worker. Missing builds/assets fail, never skip.
import { test, expect } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Server } from 'node:http';
import { startStaticServer } from '../../scripts/perf/browser-static-server.js';

const root = resolve(import.meta.dirname, '../..');
const assets = join(root, 'apps/viewer/public/smlib');
const served = new Map<string, string>();
let server: Server | undefined;
let origin: string;

test.beforeAll(async () => {
  // Stage only a freshly built adapter with the canonical staging command.
  // Its manifest identifies supplied bytes; it is not a build attestation.
  readFileSync(join(assets, 'asset-manifest.json'));
  const binary = readFileSync(join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm'));
  assert.deepEqual(binary.subarray(0, 8), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const extra = new Map<string, string>();
  for (const entry of readdirSync(assets, { withFileTypes: true })) {
    assert(entry.isFile(), `Unexpected staged asset ${entry.name}`);
    extra.set(`/smlib/${entry.name}`, join(assets, entry.name));
  }
  server = await startStaticServer({
    port: 0, host: '127.0.0.1', root: () => root, extra,
    onServe: (_url, file) => served.set(relative(root, file), createHash('sha256').update(readFileSync(file)).digest('hex')),
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) {
    const current = server;
    await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  }
});

test('canonical retained source exports execute actual Worker units, survey, cancellation and expiry', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(`${origin}/rust/wasm-bindings/tests/retained-browser-contract.html`);
    const result = page.locator('#result');
    await expect(result).not.toHaveAttribute('data-state', 'running', { timeout: 180_000 });
    await info.attach('actual-contract-result', { body: await result.innerText(), contentType: 'application/json' });
    await expect(result).toHaveAttribute('data-state', 'passed');
    const witness: unknown = JSON.parse(await result.innerText());
    expect(witness).toMatchObject({ passed: true, sourceOnly: true, fullProductQualification: false });
    expect(errors).toEqual([]);
  } finally {
    await info.attach('served-source-and-artifact-hashes', {
      body: JSON.stringify({ served: Object.fromEntries(served), pageErrors: errors }), contentType: 'application/json',
    });
  }
});
