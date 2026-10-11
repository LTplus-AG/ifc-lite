/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startViewerDevServer } from './viewer-dev-server.js';
import type * as Witness from './worker-pool-drain-7036.wasm.js';

const root = new URL('../../', import.meta.url);
const wasm = new URL('packages/wasm/pkg/ifc-lite_bg.wasm', root);
const helperUrl = `/@fs/${fileURLToPath(new URL('./worker-pool-drain-7036.wasm.ts', import.meta.url))}`;

for (const mode of ['direct', 'boot'] as const) {
  test(`#7036 ${mode} warmup cannot refill after pressure retires a genuine compile wait`, async ({ page }, info) => {
    test.skip(!existsSync(wasm), 'Source-built IFC engine absent — run pnpm build:wasm');
    const bytes = readFileSync(wasm);
    const server = await startViewerDevServer(`worker-pool-drain-${mode}-7036`);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    const requestSeen = new Promise<void>(resolve => { requested = resolve; });
    await page.route('**/ifc-lite_bg.wasm*', async route => {
      requested();
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/wasm', body: bytes });
    });
    try {
      await page.goto(new URL(`/@fs/${fileURLToPath(new URL('./worker-pool-drain-7036.entry.html', import.meta.url))}`, server.url).href);
      const wasmUrl = `/@fs/${fileURLToPath(wasm)}?retired-${mode}-7036`;
      const started = await page.evaluate(async args => {
        const helper: typeof Witness = await import(args.helperUrl);
        helper.beginWarmup(args.mode, args.wasmUrl);
        return helper.poolWitnessState();
      }, { mode, helperUrl, wasmUrl });
      // The request is observed by the independent HTTP interceptor, not a
      // manufactured compilation promise or fake worker reply.
      await Promise.race([requestSeen, new Promise<never>((_resolve, reject) => {
        requestTimer = setTimeout(() => reject(new Error('Genuine IFC engine request was not observed')), 15_000);
      })]);
      clearTimeout(requestTimer);
      const drained = await page.evaluate(async url => {
        const helper: typeof Witness = await import(url);
        helper.drainPendingWarmup();
        return helper.poolWitnessState();
      }, helperUrl);
      expect(drained.realmId).toBe(started.realmId);
      expect(drained.timeOrigin).toBe(started.timeOrigin);
      release();
      const retired = await page.evaluate(async args => {
        const helper: typeof Witness = await import(args.helperUrl);
        return { ...await helper.settledRetiredWarmup(args.wasmUrl), witness: helper.poolWitnessState() };
      }, { helperUrl, wasmUrl });
      expect(retired.compiled).toBe(true);
      expect(retired.witness.realmId).toBe(started.realmId);
      expect(retired.witness.timeOrigin).toBe(started.timeOrigin);
      expect(retired.stats?.spawned).toBe(0);
      expect(retired.stats?.idle).toBe(0);
      expect(retired.stats?.warming).toBe(0);
      if (mode === 'direct') expect(retired.started).toBe(0);
      const fresh = await page.evaluate(async args => {
        const helper: typeof Witness = await import(args.helperUrl);
        return helper.newWarmupAfterDrain(args.wasmUrl);
      }, { helperUrl, wasmUrl });
      expect(fresh.started).toBe(2);
      expect(fresh.ready.spawned).toBe(2);
      expect(fresh.ready.idle).toBe(2);
      expect(fresh.ready.warming).toBe(0);
      expect(fresh.heaps).toHaveLength(2);
      for (const heap of fresh.heaps) expect(heap).toBeGreaterThan(0);
      expect(fresh.reset.idle).toBe(2);
      await info.attach('actual-compile-drain-worker-proof', { body: JSON.stringify({ mode, retired, fresh,
        wasmSha256: createHash('sha256').update(bytes).digest('hex') }, null, 2), contentType: 'application/json' });
    } finally {
      clearTimeout(requestTimer);
      release();
      try {
        await page.evaluate(async url => { const helper: typeof Witness = await import(url); helper.disposeWarmup(); }, helperUrl);
      } finally {
        try { await page.unrouteAll({ behavior: 'wait' }); }
        finally { await server.close(); }
      }
    }
  });
}
