// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * B1.3 spike (M6c) harness. Playwright-driven real Chrome (real GPU, not the
 * bundled headless shell — see playwright.config.ts's own comments on why:
 * the shell's WebGPU device is unreliable under software rendering; this
 * spike needs a REAL result, so it always launches the `chrome` channel).
 *
 * All data generation, encoding, the CPU BigInt reference, and the WebGPU
 * dispatch/readback happen INSIDE the browser page (not round-tripped
 * through the Node<->page protocol, which would bottleneck on serializing
 * hundreds of MB of typed-array data per chunk). Node's job is just to
 * launch the browser, inject reference.mjs's functions as page globals via
 * addScriptTag, hand the WGSL source to the page, and print/save whatever
 * small JSON summary the page computes.
 *
 * Usage:
 *   node harness.mjs                       # everything, default sizes
 *   node harness.mjs --phase=selftest
 *   node harness.mjs --phase=battery
 *   node harness.mjs --phase=throughput --sizes=100000,1000000,10000000
 */

import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wgslSource = readFileSync(join(__dirname, 'orient3d.wgsl'), 'utf8');
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

/** Everything below this line is a single big function shipped into the
 * page via page.evaluate. It relies on globals injected by addScriptTag
 * from reference.mjs (decomposeDouble, encodeTest, orient3dSignBigInt,
 * mul32Ref, nextUp, nextDown, D_MAX, WORK_LIMBS, MAG_IN_LIMBS,
 * WORDS_PER_COORD, WORDS_PER_TEST). */
async function pageMain({ wgslSource, CHUNK_SIZE, phase, sizes }) {
  const report = { phase, generatedAt: new Date().toISOString() };

  // ---- WebGPU setup --------------------------------------------------
  if (!('gpu' in navigator)) {
    report.blocker = 'navigator.gpu is undefined in this page context';
    return report;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    report.blocker = 'requestAdapter() returned null';
    return report;
  }
  // Default device limits cap maxBufferSize at 256 MiB even when the
  // adapter supports far more (this Apple M4 adapter reports ~4 GiB) —
  // explicitly request the adapter's real limits so CHUNK_SIZE-sized
  // buffers (~288 MB at 1e6 tests/chunk) don't silently fail to create.
  // (An earlier run without this hit exactly that: CreateBuffer failed,
  // the bind group became invalid, the dispatch was a silent no-op, and
  // the readback buffer's un-written zeros looked like 1,000,000 sign
  // "mismatches" that were actually a device-configuration bug, not a
  // kernel bug — see the report's battery run history if reproduced.)
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  device.addEventListener('uncapturederror', (ev) => {
    console.error('[gpu uncaptured error]', ev.error.message);
  });
  report.adapterInfo = adapter.info
    ? {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      }
    : null;
  report.limits = {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
    maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
  };

  const module = device.createShaderModule({ code: wgslSource });
  const compileInfo = await module.getCompilationInfo();
  report.shaderCompileMessages = compileInfo.messages.map(
    (m) => `${m.type}: ${m.message} (line ${m.lineNum})`
  );
  const hasCompileError = compileInfo.messages.some((m) => m.type === 'error');
  if (hasCompileError) {
    report.blocker = 'WGSL shader failed to compile';
    return report;
  }

  const mainPipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const mulPipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'mulSelfTest' } });
  const magMulPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'magMulSelfTest' },
  });

  // ---- generic dispatch helper ----------------------------------------
  async function dispatchAndRead(pipeline, bindings, numWorkgroups, readbackBytes) {
    const bg = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: bindings.map((b) => ({ binding: b.binding, resource: { buffer: b.buffer } })),
    });
    const readbackSrc = bindings.find((b) => b.isReadback).buffer;
    const readBuf = device.createBuffer({
      size: readbackBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(numWorkgroups);
    pass.end();
    enc.copyBufferToBuffer(readbackSrc, 0, readBuf, 0, readbackBytes);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    readBuf.destroy();
    return out;
  }

  function makeBuffer(data, usage) {
    const buf = device.createBuffer({
      size: Math.max(data.byteLength, 4),
      usage,
      mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buf.unmap();
    return buf;
  }

  // ---- phase: low-level primitive self-tests --------------------------
  async function runSelfTests() {
    const out = {};

    // mul32 primitive: edge cases + random pairs.
    const edgePairs = [
      [0, 0],
      [1, 1],
      [0xffffffff, 0xffffffff],
      [0xffffffff, 1],
      [0x10000, 0x10000],
      [0xdeadbeef, 0xcafebabe],
      [0x7fffffff, 0x7fffffff],
      [0x80000000, 0x80000000],
      [12345, 6789],
    ];
    const randPairs = Array.from({ length: 50 }, () => [
      (Math.random() * 0x100000000) >>> 0,
      (Math.random() * 0x100000000) >>> 0,
    ]);
    const pairs = [...edgePairs, ...randPairs];
    const pairsFlat = new Uint32Array(pairs.length * 2);
    pairs.forEach(([a, b], i) => {
      pairsFlat[i * 2] = a;
      pairsFlat[i * 2 + 1] = b;
    });
    const inBuf = makeBuffer(pairsFlat, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const outBuf = device.createBuffer({
      size: pairs.length * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const gpuOut = await dispatchAndRead(
      mulPipeline,
      [
        { binding: 2, buffer: inBuf },
        { binding: 3, buffer: outBuf, isReadback: true },
      ],
      Math.ceil(pairs.length / 64),
      pairs.length * 2 * 4
    );
    let mulMismatches = 0;
    for (let i = 0; i < pairs.length; i++) {
      const [a, b] = pairs[i];
      const expected = mul32Ref(a, b);
      const gotLo = gpuOut[i * 2];
      const gotHi = gpuOut[i * 2 + 1];
      if (gotLo !== expected.lo || gotHi !== expected.hi) {
        mulMismatches++;
        if (mulMismatches <= 3) {
          out.firstMulMismatch = { a, b, expected, got: { lo: gotLo, hi: gotHi } };
        }
      }
    }
    out.mul32 = { cases: pairs.length, mismatches: mulMismatches };

    // magMul (512-bit schoolbook multiply), truncated-product semantics:
    // expected = (a * b) mod 2^512, compared limb-for-limb.
    function randLimbs16() {
      const limbs = new Uint32Array(16);
      for (let i = 0; i < 16; i++) limbs[i] = (Math.random() * 0x100000000) >>> 0;
      return limbs;
    }
    function limbsToBig(limbs) {
      let v = 0n;
      for (let i = 15; i >= 0; i--) v = (v << 32n) | BigInt(limbs[i]);
      return v;
    }
    function bigToLimbs16(v) {
      const out = new Uint32Array(16);
      let x = v & ((1n << 512n) - 1n);
      for (let i = 0; i < 16; i++) {
        out[i] = Number(x & 0xffffffffn);
        x >>= 32n;
      }
      return out;
    }
    const magCases = [];
    // a few structured cases (small values, all-ones low limbs) plus random.
    {
      const a = new Uint32Array(16);
      const b = new Uint32Array(16);
      a[0] = 12345;
      b[0] = 6789;
      magCases.push([a, b]);
    }
    {
      const a = new Uint32Array(16);
      const b = new Uint32Array(16);
      a[0] = 0xffffffff;
      a[1] = 0xffffffff;
      b[0] = 0xffffffff;
      magCases.push([a, b]);
    }
    for (let i = 0; i < 20; i++) magCases.push([randLimbs16(), randLimbs16()]);

    const magIn = new Uint32Array(magCases.length * 32);
    magCases.forEach(([a, b], i) => {
      magIn.set(a, i * 32);
      magIn.set(b, i * 32 + 16);
    });
    const magInBuf = makeBuffer(magIn, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const magOutBuf = device.createBuffer({
      size: magCases.length * 16 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const magGpuOut = await dispatchAndRead(
      magMulPipeline,
      [
        { binding: 4, buffer: magInBuf },
        { binding: 5, buffer: magOutBuf, isReadback: true },
      ],
      Math.ceil(magCases.length / 64),
      magCases.length * 16 * 4
    );
    let magMismatches = 0;
    for (let i = 0; i < magCases.length; i++) {
      const [a, b] = magCases[i];
      const expected = bigToLimbs16(limbsToBig(a) * limbsToBig(b));
      const got = magGpuOut.subarray(i * 16, i * 16 + 16);
      let eq = true;
      for (let j = 0; j < 16; j++) if (got[j] !== expected[j]) eq = false;
      if (!eq) {
        magMismatches++;
        if (magMismatches <= 2) {
          out.firstMagMulMismatch = { expected: Array.from(expected), got: Array.from(got) };
        }
      }
    }
    out.magMul = { cases: magCases.length, mismatches: magMismatches };

    return out;
  }

  // ---- test-case generators (adversarial + random) --------------------
  function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }
  function genRandomUniformFlat(n, mag) {
    const arr = new Float64Array(n * 12);
    for (let i = 0; i < arr.length; i++) arr[i] = randRange(-mag, mag);
    return arr;
  }
  function genCoplanarUlpTests(nBases) {
    const tests = [];
    for (let i = 0; i < nBases; i++) {
      const ax = randRange(-1000, 1000),
        ay = randRange(-1000, 1000),
        az = randRange(-1000, 1000);
      const bx = randRange(-1000, 1000),
        by = randRange(-1000, 1000),
        bz = randRange(-1000, 1000);
      const cx = randRange(-1000, 1000),
        cy = randRange(-1000, 1000),
        cz = randRange(-1000, 1000);
      const t1 = randRange(0.2, 0.8),
        t2 = randRange(0.2, 0.8);
      const dx = ax + t1 * (bx - ax) + t2 * (cx - ax);
      const dy = ay + t1 * (by - ay) + t2 * (cy - ay);
      const dz = az + t1 * (bz - az) + t2 * (cz - az);
      const base = [ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz];
      tests.push(base.slice());
      for (let k = 0; k < 12; k++) {
        const up = base.slice();
        up[k] = nextUp(up[k]);
        tests.push(up);
        const down = base.slice();
        down[k] = nextDown(down[k]);
        tests.push(down);
      }
    }
    return tests;
  }
  function genLastBitDiffTests(n) {
    const tests = [];
    for (let i = 0; i < n; i++) {
      const base = [randRange(-1000, 1000), randRange(-1000, 1000), randRange(-1000, 1000)];
      const p2 = [randRange(-1000, 1000), randRange(-1000, 1000), randRange(-1000, 1000)];
      const p3 = [randRange(-1000, 1000), randRange(-1000, 1000), randRange(-1000, 1000)];
      const p4 = base.map(nextUp);
      tests.push([...base, ...p2, ...p3, ...p4]);
    }
    return tests;
  }
  function genExponentSpreadEdgeTests() {
    const tests = [];
    for (const D of [D_MAX - 1, D_MAX, D_MAX + 1, D_MAX + 20, D_MAX + 200]) {
      const tiny = Math.pow(2, -D);
      tests.push({ D, test: [0, 0, 0, 1, 0, 0, 0, 1, 0, tiny, tiny, 0] });
      tests.push({ D, test: [0, 0, 0, 1, 0, 0, 0, 1, 0, -tiny, tiny, 0] });
    }
    return tests;
  }
  function genExactZeroTests() {
    return [
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
      [-0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
      [1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3],
      [1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0],
    ];
  }
  function genSubnormalMixedTests(n) {
    const tests = [];
    for (let i = 0; i < n; i++) {
      const sub = Number.MIN_VALUE * (1 + Math.floor(Math.random() * 10));
      tests.push([0, 0, 0, 1, 0, 0, 0, 1, 0, sub, sub, 0]);
    }
    return tests;
  }

  // ---- run a flat Float64Array of tests through: encode -> GPU dispatch
  // (chunked) -> compare against orient3dSignBigInt. Returns per-run stats.
  async function runTestsFlat(coordsFlat, label) {
    const n = coordsFlat.length / 12;
    let mismatches = 0;
    let fallback = 0;
    let checked = 0;
    let nanSkipped = 0;
    const mismatchSamples = [];
    let gpuTimeMs = 0;

    for (let chunkStart = 0; chunkStart < n; chunkStart += CHUNK_SIZE) {
      const chunkN = Math.min(CHUNK_SIZE, n - chunkStart);
      const words = new Uint32Array(chunkN * WORDS_PER_TEST);
      const refSign = new Int8Array(chunkN);
      const isValid = new Uint8Array(chunkN);
      let validCount = 0;
      const validIndexOfLocal = new Int32Array(chunkN).fill(-1);

      for (let i = 0; i < chunkN; i++) {
        const off = (chunkStart + i) * 12;
        const coords = coordsFlat.subarray(off, off + 12);
        const ref = orient3dSignBigInt(coords);
        if (ref === null) {
          nanSkipped++;
          continue;
        }
        refSign[i] = ref;
        const enc = encodeTest(coords);
        if (enc.valid) {
          isValid[i] = 1;
          words.set(enc.words, validCount * WORDS_PER_TEST);
          validIndexOfLocal[validCount] = i;
          validCount++;
        } else {
          fallback++;
        }
      }

      if (validCount > 0) {
        const inBuf = makeBuffer(
          words.subarray(0, validCount * WORDS_PER_TEST),
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        );
        const outBuf = device.createBuffer({
          size: validCount * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const t0 = performance.now();
        const gpuOut = await dispatchAndRead(
          mainPipeline,
          [
            { binding: 0, buffer: inBuf },
            { binding: 1, buffer: outBuf, isReadback: true },
          ],
          Math.ceil(validCount / 64),
          validCount * 4
        );
        gpuTimeMs += performance.now() - t0;
        inBuf.destroy();
        outBuf.destroy();

        for (let k = 0; k < validCount; k++) {
          const localIdx = validIndexOfLocal[k];
          const gotSignRaw = gpuOut[k] | 0; // reinterpret as i32
          const got = gotSignRaw > 0x7fffffff ? gotSignRaw - 0x100000000 : gotSignRaw;
          checked++;
          if (got !== refSign[localIdx]) {
            mismatches++;
            if (mismatchSamples.length < 5) {
              mismatchSamples.push({
                coords: Array.from(coordsFlat.subarray((chunkStart + localIdx) * 12, (chunkStart + localIdx) * 12 + 12)),
                expected: refSign[localIdx],
                got,
              });
            }
          }
        }
      }
    }

    return { label, totalCases: n, checked, mismatches, fallback, nanSkipped, gpuTimeMs, mismatchSamples };
  }

  async function runTestArray(testsArray, label) {
    const flat = new Float64Array(testsArray.length * 12);
    testsArray.forEach((t, i) => flat.set(t, i * 12));
    return runTestsFlat(flat, label);
  }

  // ---- phase: correctness battery -------------------------------------
  async function runBattery() {
    const results = [];

    results.push(await runTestsFlat(genRandomUniformFlat(1_000_000, 1000), 'random_uniform_1e6_mag1e3'));
    results.push(await runTestsFlat(genRandomUniformFlat(200_000, 1e9), 'random_uniform_2e5_mag1e9'));
    results.push(await runTestsFlat(genRandomUniformFlat(200_000, 1e-6), 'random_uniform_2e5_mag1e-6'));

    results.push(await runTestArray(genCoplanarUlpTests(2000), 'coplanar_1ulp_perturbations'));
    results.push(await runTestArray(genLastBitDiffTests(50_000), 'last_bit_diff'));
    results.push(await runTestArray(genExactZeroTests(), 'exact_zeros_and_collinear'));
    results.push(await runTestArray(genSubnormalMixedTests(500), 'subnormal_mixed_must_fallback'));

    // exponent-spread edge cases, tracked per-D so we can confirm the exact
    // cap boundary (D_MAX valid, D_MAX+1 must fallback), not just aggregate.
    const edgeCases = genExponentSpreadEdgeTests();
    const byD = new Map();
    for (const { D, test } of edgeCases) {
      if (!byD.has(D)) byD.set(D, []);
      byD.get(D).push(test);
    }
    const edgeResults = [];
    for (const [D, tests] of byD) {
      const r = await runTestArray(tests, `exponent_spread_D${D}`);
      edgeResults.push({ D, ...r });
    }
    results.push(...edgeResults);

    return results;
  }

  // ---- phase: throughput sweep -----------------------------------------
  //
  // Generates, encodes, uploads, and dispatches one CHUNK_SIZE slice at a
  // time — never allocating a single buffer sized for the whole batch.
  // (An earlier version pre-allocated one `n * WORDS_PER_TEST` Uint32Array
  // up front; at n=1e7 that's a single ~2.88 GB ArrayBuffer, which blew
  // past this engine's array-buffer allocation ceiling with a RangeError.
  // Chunking avoids the problem AND is the more realistic shape for a real
  // streaming caller.)
  async function runThroughput(sizesList) {
    const rows = [];
    for (const n of sizesList) {
      let validCount = 0;
      let encodeMs = 0;
      let gpuMs = 0;

      for (let chunkStart = 0; chunkStart < n; chunkStart += CHUNK_SIZE) {
        const chunkN = Math.min(CHUNK_SIZE, n - chunkStart);
        const flat = genRandomUniformFlat(chunkN, 1000);

        const encodeT0 = performance.now();
        const words = new Uint32Array(chunkN * WORDS_PER_TEST);
        let chunkValid = 0;
        for (let i = 0; i < chunkN; i++) {
          const off = i * 12;
          const enc = encodeTest(flat.subarray(off, off + 12));
          if (enc.valid) {
            words.set(enc.words, chunkValid * WORDS_PER_TEST);
            chunkValid++;
          }
        }
        encodeMs += performance.now() - encodeT0;
        validCount += chunkValid;

        if (chunkValid > 0) {
          const inBuf = makeBuffer(
            words.subarray(0, chunkValid * WORDS_PER_TEST),
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
          );
          const outBuf = device.createBuffer({
            size: chunkValid * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          });
          const t0 = performance.now();
          await dispatchAndRead(
            mainPipeline,
            [
              { binding: 0, buffer: inBuf },
              { binding: 1, buffer: outBuf, isReadback: true },
            ],
            Math.ceil(chunkValid / 64),
            chunkValid * 4
          );
          gpuMs += performance.now() - t0;
          inBuf.destroy();
          outBuf.destroy();
        }
      }

      // CPU single-thread BigInt exact baseline, measured on a fresh,
      // independently-generated set of the SAME size n (not reusing the
      // GPU chunks' data, but the same distribution) — the fair "real CPU
      // exact path" comparator per the task brief. Chunked generation here
      // too, for the same allocation-ceiling reason as above.
      let cpuMs = 0;
      let cpuSignSum = 0; // touch the result so V8 can't dead-code-eliminate the loop
      for (let chunkStart = 0; chunkStart < n; chunkStart += CHUNK_SIZE) {
        const chunkN = Math.min(CHUNK_SIZE, n - chunkStart);
        const flat = genRandomUniformFlat(chunkN, 1000);
        const cpuT0 = performance.now();
        for (let i = 0; i < chunkN; i++) {
          const off = i * 12;
          cpuSignSum += orient3dSignBigInt(flat.subarray(off, off + 12));
        }
        cpuMs += performance.now() - cpuT0;
      }

      rows.push({
        n,
        validCount,
        fallbackCount: n - validCount,
        encodeMs,
        gpuMs,
        cpuBigIntMs: cpuMs,
        gpuPredicatesPerSec: (validCount / gpuMs) * 1000,
        cpuPredicatesPerSec: (n / cpuMs) * 1000,
        gpuIncludingEncodePredicatesPerSec: (validCount / (gpuMs + encodeMs)) * 1000,
        cpuSignSumTouch: cpuSignSum,
      });
    }
    return rows;
  }

  if (phase === 'selftest' || phase === 'all') {
    report.selfTests = await runSelfTests();
  }
  if (phase === 'battery' || phase === 'all') {
    report.battery = await runBattery();
  }
  if (phase === 'throughput' || phase === 'all') {
    report.throughput = await runThroughput(sizes);
  }

  return report;
}

async function main() {
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
    // file:// gives isSecureContext = true without needing a dev server —
    // navigator.gpu is undefined on about:blank/data: URLs (not secure).
    await page.goto('file:///tmp/');
    await page.addScriptTag({ content: refSource });

    const report = await page.evaluate(pageMain, { wgslSource, CHUNK_SIZE, phase, sizes });
    const outPath = join(__dirname, `report.${phase}.json`);
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
