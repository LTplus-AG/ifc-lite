# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: retained-browser.e2e.spec.ts >> canonical retained source exports execute actual Worker units, survey, cancellation and expiry
- Location: tests/e2e/retained-browser.e2e.spec.ts:44:1

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator:  locator('#result')
Expected: "passed"
Received: "failed"
Timeout:  5000ms

Call log:
  - Expect "toHaveAttribute" locator('#result') with timeout 5000ms
  - waiting for locator('#result')
    14 × locator resolved to <pre id="result" data-state="failed">{"passed":false,"error":"SyntaxError: The request…</pre>
       - unexpected value "failed"

```

```yaml
- text: "{\"passed\":false,\"error\":\"SyntaxError: The requested module './snippets/ifc-lite-geometry-runtime-038e5854b2a5a0e1/js/retained-driver.mjs' does not provide an export named 'Driver'\",\"stack\":\"SyntaxError: The requested module './snippets/ifc-lite-geometry-runtime-038e5854b2a5a0e1/js/retained-driver.mjs' does not provide an export named 'Driver'\"}"
```

# Test source

```ts
  1  | // SPDX-License-Identifier: MPL-2.0
  2  | // Canonical public JS API + actual SDK Worker. Missing builds/assets fail, never skip.
  3  | import { test, expect } from '@playwright/test';
  4  | import { strict as assert } from 'node:assert';
  5  | import { createHash } from 'node:crypto';
  6  | import { readFileSync, readdirSync } from 'node:fs';
  7  | import { join, relative, resolve } from 'node:path';
  8  | import type { Server } from 'node:http';
  9  | import { startStaticServer } from '../../scripts/perf/browser-static-server.js';
  10 | 
  11 | const root = resolve(import.meta.dirname, '../..');
  12 | const assets = join(root, 'apps/viewer/public/smlib');
  13 | const served = new Map<string, string>();
  14 | let server: Server | undefined;
  15 | let origin: string;
  16 | 
  17 | test.beforeAll(async () => {
  18 |   // Stage only a freshly built adapter with the canonical staging command.
  19 |   // Its manifest identifies supplied bytes; it is not a build attestation.
  20 |   readFileSync(join(assets, 'asset-manifest.json'));
  21 |   const binary = readFileSync(join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm'));
  22 |   assert.deepEqual(binary.subarray(0, 8), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  23 |   const extra = new Map<string, string>();
  24 |   for (const entry of readdirSync(assets, { withFileTypes: true })) {
  25 |     assert(entry.isFile(), `Unexpected staged asset ${entry.name}`);
  26 |     extra.set(`/smlib/${entry.name}`, join(assets, entry.name));
  27 |   }
  28 |   server = await startStaticServer({
  29 |     port: 0, host: '127.0.0.1', root: () => root, extra,
  30 |     onServe: (_url, file) => served.set(relative(root, file), createHash('sha256').update(readFileSync(file)).digest('hex')),
  31 |   });
  32 |   const address = server.address();
  33 |   assert(address && typeof address !== 'string');
  34 |   origin = `http://127.0.0.1:${address.port}`;
  35 | });
  36 | 
  37 | test.afterAll(async () => {
  38 |   if (server) {
  39 |     const current = server;
  40 |     await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
  41 |   }
  42 | });
  43 | 
  44 | test('canonical retained source exports execute actual Worker units, survey, cancellation and expiry', async ({ page }, info) => {
  45 |   const errors: string[] = [];
  46 |   page.on('pageerror', error => errors.push(String(error)));
  47 |   try {
  48 |     await page.goto(`${origin}/rust/wasm-bindings/tests/retained-browser-contract.html`);
  49 |     const result = page.locator('#result');
  50 |     await expect(result).not.toHaveAttribute('data-state', 'running', { timeout: 180_000 });
  51 |     await info.attach('actual-contract-result', { body: await result.innerText(), contentType: 'application/json' });
> 52 |     await expect(result).toHaveAttribute('data-state', 'passed');
     |                          ^ Error: expect(locator).toHaveAttribute(expected) failed
  53 |     const witness: unknown = JSON.parse(await result.innerText());
  54 |     expect(witness).toMatchObject({ passed: true, sourceOnly: true, fullProductQualification: false });
  55 |     expect(errors).toEqual([]);
  56 |   } finally {
  57 |     await info.attach('served-source-and-artifact-hashes', {
  58 |       body: JSON.stringify({ served: Object.fromEntries(served), pageErrors: errors }), contentType: 'application/json',
  59 |     });
  60 |   }
  61 | });
  62 | 
```