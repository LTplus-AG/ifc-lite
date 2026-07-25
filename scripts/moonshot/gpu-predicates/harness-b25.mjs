// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * B2.5 harness (M6c follow-up): encode-bottleneck attack + incircle.
 *
 * Same execution model as the B1.3 harness.mjs (Playwright-driven real
 * Chrome `chrome` channel, headed, WebGPU flags; all data generation,
 * encoding, CPU BigInt references, and GPU dispatch/readback run INSIDE
 * the page). harness.mjs is left untouched so the B1.3 baseline stays
 * reproducible bit-for-bit; this file only adds the B2.5 paths:
 *
 *   path A (baseline, measured by harness.mjs): BigInt CPU encode
 *           + 16-limb kernel (orient3d.wgsl `main`)
 *   path B: BigInt-free fast CPU encode (reference.mjs::encodeTestFast)
 *           + the SAME 16-limb kernel
 *   path C: raw f64 bits upload (zero CPU arithmetic) + GPU-side
 *           decode/frame/gate + 20-limb length-aware kernel
 *           (predicates-raw.wgsl orient3dRaw / incircleRaw)
 *
 * Usage:
 *   node harness-b25.mjs                            # all browser phases
 *   node harness-b25.mjs --phase=encodecheck        # Node-only, no browser
 *   node harness-b25.mjs --phase=selftest
 *   node harness-b25.mjs --phase=battery            # orient3d raw-path battery
 *   node harness-b25.mjs --phase=incircle           # incircle raw-path battery
 *   node harness-b25.mjs --phase=throughput --sizes=100000,1000000,10000000
 */

import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runEncodeCheck } from './b25-encode-check.mjs';
import { pageMain } from './b25-page-main.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wgslBase = readFileSync(join(__dirname, 'orient3d.wgsl'), 'utf8');
const wgslRaw = readFileSync(join(__dirname, 'predicates-raw.wgsl'), 'utf8');
const refSource = readFileSync(join(__dirname, 'reference.mjs'), 'utf8').replace(
  /^export (function|const)/gm,
  '$1'
);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const phase = args.phase ?? 'all';
const sizes = (args.sizes ?? '100000,1000000,10000000').split(',').map((s) => parseInt(s, 10));
const CHUNK_SIZE = args.chunk ? parseInt(args.chunk, 10) : 1_000_000;
// dispatchAndRead issues ceil(chunkN / 64) workgroups on one dimension; the
// WebGPU baseline maxComputeWorkgroupsPerDimension is 65535, so anything
// above 64 * 65535 would exceed the limit inside the (frozen) page code.
const MAX_CHUNK = 64 * 65535;
if (!Number.isInteger(CHUNK_SIZE) || CHUNK_SIZE < 1 || CHUNK_SIZE > MAX_CHUNK) {
  console.error(`error: --chunk must be an integer in [1, ${MAX_CHUNK}], got ${JSON.stringify(args.chunk)}`);
  process.exit(2);
}


async function main() {
  if (phase === 'encodecheck') {
    const report = await runEncodeCheck();
    const outPath = join(__dirname, 'report.b25.encodecheck.json');
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Report written to ${outPath}`);
    console.log(JSON.stringify(report, null, 2));
    if (report.totalMismatches > 0) process.exit(1);
    return;
  }

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--enable-gpu',
      '--enable-webgpu',
      '--enable-unsafe-webgpu',
      '--use-angle=default',
      '--ignore-gpu-blocklist',
    ],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[page error]', String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text());
    });
    await page.goto('file:///tmp/');
    await page.addScriptTag({ content: refSource });

    const report = await page.evaluate(pageMain, { wgslBase, wgslRaw, CHUNK_SIZE, phase, sizes });
    const outPath = join(__dirname, `report.b25.${phase}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Report written to ${outPath}`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
