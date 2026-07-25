// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * B3.4 harness: run the REAL kernel-stage orient3d workload (extracted from
 * captured CSG corpora by extractor/, see REPORT.md) through the B2.5 GPU
 * exact-predicate library (path C: raw f64-bits upload, GPU-side decode +
 * 640-bit exact arithmetic), and compare sign-for-sign + wall-clock against:
 *
 *   - the extracted PRODUCTION signs (Rust kernel Shewchuk adaptive path),
 *     including the FNV-1a sign manifest computed natively, and
 *   - an in-page exact CPU evaluation (BigInt oracle from the B2.5 spike,
 *     the like-for-like "exact CPU evaluation" baseline).
 *
 * Execution model matches harness-b25.mjs: Playwright real Chrome, WebGPU,
 * everything measured inside the page. Workload binaries are served to the
 * page via request interception (no copies through evaluate args).
 *
 * Usage:
 *   node harness-b34.mjs --dir=<scratch>/b34 --models=duplex,advanced,holter,c20,i129
 *       [--repeats=20] [--amplify=100]
 *
 * --amplify=K additionally times a K-times-tiled copy of each workload
 * (EXPLICITLY LABELED synthetic amplification; parity is still checked on the
 * tiled data, but the number exists only to locate the batch-size crossover).
 */

import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wgslRaw = readFileSync(join(__dirname, '..', 'gpu-predicates', 'predicates-raw.wgsl'), 'utf8');
const refSource = readFileSync(join(__dirname, '..', 'gpu-predicates', 'reference.mjs'), 'utf8').replace(
  /^export (function|const)/gm,
  '$1'
);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const dir = args.dir;
if (!dir) {
  console.error('missing --dir=<path to extracted workloads>');
  process.exit(2);
}
const models = (args.models ?? 'duplex,advanced,holter,c20,i129').split(',');
const repeats = parseInt(args.repeats ?? '20', 10);
const amplify = args.amplify ? parseInt(args.amplify, 10) : 0;
if (!Number.isInteger(repeats) || repeats < 1) {
  console.error(`error: --repeats expects a positive integer, got ${JSON.stringify(args.repeats)}`);
  process.exit(2);
}
if (!Number.isInteger(amplify) || amplify < 0) {
  console.error(`error: --amplify expects a non-negative integer, got ${JSON.stringify(args.amplify)}`);
  process.exit(2);
}

// ---- collect available workloads ------------------------------------------
const found = [];
for (const m of models) {
  const w = join(dir, `${m}.workload.bin`);
  const s = join(dir, `${m}.signs.bin`);
  const j = join(dir, `${m}.meta.json`);
  if (existsSync(w) && existsSync(s) && existsSync(j)) {
    found.push({ name: m, workload: w, signs: s, meta: JSON.parse(readFileSync(j, 'utf8')) });
  } else {
    console.error(`skip model '${m}': extracted workload not found in ${dir}`);
  }
}
if (found.length === 0) {
  console.error('no workloads found - run the extractor first (see REPORT.md)');
  process.exit(0);
}

async function pageMain({ wgslRaw, modelsIn, repeats, amplify }) {
  const report = { generatedAt: new Date().toISOString(), repeats, amplify: amplify || null, models: [] };
  const FALLBACK = 2;

  if (!('gpu' in navigator)) {
    report.blocker = 'navigator.gpu is undefined';
    return report;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    report.blocker = 'requestAdapter() returned null';
    return report;
  }
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  device.addEventListener('uncapturederror', (ev) => console.error('[gpu]', ev.error.message));
  report.adapterInfo = adapter.info
    ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture }
    : null;

  const module = device.createShaderModule({ code: wgslRaw });
  {
    const info = await module.getCompilationInfo();
    if (info.messages.some((m) => m.type === 'error')) {
      report.blocker = 'WGSL compile: ' + info.messages.map((m) => m.message).join('; ');
      return report;
    }
  }
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'orient3dRaw' },
  });

  function makeBuffer(view, usage) {
    const buf = device.createBuffer({ size: Math.max(view.byteLength, 4), usage, mappedAtCreation: true });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    buf.unmap();
    return buf;
  }

  const asI32 = (u) => (u > 0x7fffffff ? u - 0x100000000 : u);

  // One dispatch over tuples [start, start+n) of flat (Float64Array), reading
  // back n i32 signs. Returns { out, ms } with ms = upload+dispatch+readback.
  async function runGpu(flat, start, n) {
    const t0 = performance.now();
    const rawView = new Uint32Array(flat.buffer, flat.byteOffset + start * 12 * 8, n * 24);
    const inBuf = makeBuffer(rawView, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const outBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bg = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inBuf } },
        { binding: 1, resource: { buffer: outBuf } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, n * 4);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    inBuf.destroy();
    outBuf.destroy();
    readBuf.destroy();
    return { out, ms: performance.now() - t0 };
  }

  // FNV-1a over sign codes (-1 -> 0, 0 -> 1, +1 -> 2), matching
  // rust/geometry/src/kernel/manifest.rs::mix and the extractor.
  function manifestHash(signsI8) {
    const MASK = 0xffffffffffffffffn;
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < signsI8.length; i++) {
      const code = signsI8[i] === -1 ? 0n : signsI8[i] === 0 ? 1n : 2n;
      h ^= code;
      h = (h * 0x100000001b3n) & MASK;
    }
    return '0x' + h.toString(16).padStart(16, '0');
  }

  function batchStats(counts) {
    if (counts.length === 0) return null;
    const sorted = [...counts].sort((a, b) => a - b);
    const sum = sorted.reduce((s, x) => s + x, 0);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return {
      nBatches: sorted.length,
      min: sorted[0],
      p50: q(0.5),
      p90: q(0.9),
      max: sorted[sorted.length - 1],
      mean: sum / sorted.length,
      total: sum,
    };
  }

  // warmup: forces pipeline compile out of every timed region
  {
    const w = new Float64Array(4096 * 12);
    for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2000 - 1000;
    await runGpu(w, 0, 4096);
  }

  for (const model of modelsIn) {
    const m = { name: model.name, meta: model.meta };
    const wl = new Float64Array(await (await fetch(model.workloadUrl)).arrayBuffer());
    const cpuSigns = new Int8Array(await (await fetch(model.signsUrl)).arrayBuffer());
    const n = wl.length / 12;
    m.tuples = n;
    if (n === 0 || n !== cpuSigns.length) {
      m.error = `bad workload: ${n} tuples vs ${cpuSigns.length} signs`;
      report.models.push(m);
      continue;
    }

    // --- parity + whole-stage GPU timing --------------------------------
    let gpuSigns = null;
    let bestWhole = Infinity;
    const wholeTimes = [];
    for (let r = 0; r < repeats; r++) {
      const { out, ms } = await runGpu(wl, 0, n);
      wholeTimes.push(ms);
      bestWhole = Math.min(bestWhole, ms);
      if (!gpuSigns) gpuSigns = out;
    }
    let mismatches = 0;
    let gpuFallbacks = 0;
    const mismatchSamples = [];
    const g = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const got = asI32(gpuSigns[i]);
      if (got === FALLBACK) gpuFallbacks++;
      g[i] = got === FALLBACK ? 3 : got;
      if (got !== cpuSigns[i]) {
        mismatches++;
        if (mismatchSamples.length < 5) {
          mismatchSamples.push({ i, expected: cpuSigns[i], got, coords: Array.from(wl.subarray(i * 12, i * 12 + 12)) });
        }
      }
    }
    m.parity = { mismatches, gpuFallbacks, mismatchSamples };
    m.manifest = {
      rust: model.meta.signManifestFnv1a,
      gpu: manifestHash(g),
      match: null,
    };
    m.manifest.match = m.manifest.rust === m.manifest.gpu;

    // --- BigInt exact CPU oracle: parity + timing -----------------------
    {
      let oracleMismatches = 0;
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          const s = orient3dSignBigInt(wl.subarray(i * 12, i * 12 + 12));
          if (r === 0 && s !== cpuSigns[i]) oracleMismatches++;
        }
        best = Math.min(best, performance.now() - t0);
      }
      m.cpuBigInt = { ms: best, mismatchesVsRust: oracleMismatches };
    }

    // --- per-op dispatch (the realized per-CSG-job batch sizes) ---------
    {
      const counts = model.meta.jobTupleCounts.filter((c) => c > 0);
      m.perOpBatchStats = batchStats(counts);
      let best = Infinity;
      const perOpRepeats = Math.max(3, Math.floor(repeats / 4));
      for (let r = 0; r < perOpRepeats; r++) {
        let total = 0;
        let off = 0;
        for (const c of model.meta.jobTupleCounts) {
          if (c === 0) continue;
          const { ms } = await runGpu(wl, off, c);
          total += ms;
          off += c;
        }
        best = Math.min(best, total);
      }
      m.gpuPerOpMs = best;
    }

    m.gpuWholeMs = bestWhole;
    m.gpuWholeMedianMs = wholeTimes.sort((a, b) => a - b)[Math.floor(wholeTimes.length / 2)];
    m.nativeStageMs = model.meta.nativeStageMsBestOf5;
    m.speedups = {
      gpuWholeVsCpuBigInt: m.cpuBigInt.ms / m.gpuWholeMs,
      gpuPerOpVsCpuBigInt: m.cpuBigInt.ms / m.gpuPerOpMs,
      gpuWholeVsNativeShewchuk: m.nativeStageMs / m.gpuWholeMs,
    };

    // --- optional amplified run (synthetic tiling, labeled) --------------
    if (amplify > 1) {
      const big = new Float64Array(wl.length * amplify);
      for (let k = 0; k < amplify; k++) big.set(wl, k * wl.length);
      const bigN = n * amplify;
      // chunk to stay well under maxStorageBufferBindingSize (96 B/tuple)
      const CHUNK = 1_000_000;
      let best = Infinity;
      let amp = null;
      for (let r = 0; r < 3; r++) {
        let total = 0;
        const outs = [];
        for (let start = 0; start < bigN; start += CHUNK) {
          const c = Math.min(CHUNK, bigN - start);
          const { out, ms } = await runGpu(big, start, c);
          total += ms;
          if (!amp) outs.push(out);
        }
        best = Math.min(best, total);
        if (!amp) amp = outs;
      }
      let ampMismatches = 0;
      {
        let i = 0;
        for (const out of amp) {
          for (let k = 0; k < out.length; k++, i++) {
            if (asI32(out[k]) !== cpuSigns[i % n]) ampMismatches++;
          }
        }
      }
      m.amplified = {
        note: 'SYNTHETIC: workload tiled x' + amplify + ' to locate the batch-size crossover; not a real model measurement',
        tuples: bigN,
        gpuMs: best,
        mismatches: ampMismatches,
        cpuBigIntMsScaled: m.cpuBigInt.ms * amplify,
        nativeShewchukMsScaled: m.nativeStageMs * amplify,
        gpuVsCpuBigIntScaled: (m.cpuBigInt.ms * amplify) / best,
        gpuVsNativeShewchukScaled: (m.nativeStageMs * amplify) / best,
      };
    }

    report.models.push(m);
  }

  return report;
}

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[page error]', String(e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') console.log('[console]', msg.type(), msg.text());
    });

    // Serve the workload binaries to the file:// page via interception.
    const files = new Map();
    const modelsIn = found.map((f, i) => {
      const wUrl = `https://b34.workloads.local/${i}.workload.bin`;
      const sUrl = `https://b34.workloads.local/${i}.signs.bin`;
      files.set(wUrl, readFileSync(f.workload));
      files.set(sUrl, readFileSync(f.signs));
      return { name: f.name, meta: f.meta, workloadUrl: wUrl, signsUrl: sUrl };
    });
    await page.route('https://b34.workloads.local/**', (route) => {
      const body = files.get(route.request().url());
      if (!body) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({
        status: 200,
        body,
        headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' },
      });
    });

    await page.goto('file:///tmp/');
    await page.addScriptTag({ content: refSource });

    const report = await page.evaluate(pageMain, { wgslRaw, modelsIn, repeats, amplify });
    const outPath = join(__dirname, 'report.b34.json');
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Report written to ${outPath}`);
    console.log(JSON.stringify(report, null, 2));
    const bad = (report.models ?? []).some((m) => (m.parity && m.parity.mismatches > 0) || (m.manifest && !m.manifest.match));
    if (report.blocker || bad) process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
