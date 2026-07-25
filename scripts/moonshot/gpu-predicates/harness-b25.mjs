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

// ---- phase: encodecheck (pure Node, no browser, no GPU) --------------------
//
// Proves encodeTestFast (BigInt-free) is word-for-word identical to the
// trusted BigInt encoder encodeTest over random + adversarial inputs.
async function runEncodeCheck() {
  const ref = await import('./reference.mjs');
  const report = { phase: 'encodecheck', generatedAt: new Date().toISOString() };

  function compareOne(coords) {
    const a = ref.encodeTest(coords);
    const b = ref.encodeTestFast(coords);
    if (a.valid !== b.valid) return `valid mismatch: ${a.valid} vs ${b.valid}`;
    if ((a.D ?? null) !== (b.D ?? null)) return `D mismatch: ${a.D} vs ${b.D}`;
    if ((a.eMin ?? null) !== (b.eMin ?? null)) return `eMin mismatch: ${a.eMin} vs ${b.eMin}`;
    if (a.valid) {
      for (let i = 0; i < a.words.length; i++) {
        if (a.words[i] !== b.words[i]) return `word[${i}] mismatch: ${a.words[i]} vs ${b.words[i]}`;
      }
    }
    return null;
  }

  const rand = (mag) => (Math.random() * 2 - 1) * mag;
  const specialPool = [
    0, -0, 1, -1, Number.MIN_VALUE, -Number.MIN_VALUE, 5e-324, 2.2250738585072014e-308,
    1.7976931348623157e308, -1.7976931348623157e308, 1e-300, 1e300, Math.PI, -Math.E,
    Math.pow(2, -1000), Math.pow(2, 1000), NaN, Infinity, -Infinity, 6755399441055744.0,
  ];

  const sets = [];
  {
    const tests = [];
    for (let i = 0; i < 200000; i++) tests.push(Array.from({ length: 12 }, () => rand(1000)));
    sets.push(['random_mag1e3_2e5', tests]);
  }
  {
    const tests = [];
    for (let i = 0; i < 50000; i++) tests.push(Array.from({ length: 12 }, () => rand(1e9)));
    sets.push(['random_mag1e9_5e4', tests]);
  }
  {
    const tests = [];
    for (let i = 0; i < 50000; i++) tests.push(Array.from({ length: 12 }, () => rand(1e-6)));
    sets.push(['random_mag1e-6_5e4', tests]);
  }
  {
    // adversarial: mixtures drawn from the special pool (zeros, subnormals,
    // DBL_MAX, NaN/Inf, exact powers of two) plus wide-spread constructions
    // that straddle the D_MAX boundary.
    const tests = [];
    for (let i = 0; i < 30000; i++) {
      tests.push(
        Array.from({ length: 12 }, () =>
          Math.random() < 0.5 ? specialPool[(Math.random() * specialPool.length) | 0] : rand(1000)
        )
      );
    }
    for (const D of [98, 99, 100, 101, 102, 150, 1074]) {
      const tiny = Math.pow(2, -D);
      tests.push([0, 0, 0, 1, 0, 0, 0, 1, 0, tiny, tiny, 0]);
      tests.push([0, 0, 0, 1, 0, 0, 0, 1, 0, -tiny, tiny, 0]);
    }
    tests.push(new Array(12).fill(0));
    tests.push(new Array(12).fill(-0));
    sets.push(['adversarial_specials_3e4', tests]);
  }

  const results = [];
  for (const [label, tests] of sets) {
    let mismatches = 0;
    let firstMismatch = null;
    const t0 = performance.now();
    for (const t of tests) {
      const err = compareOne(t);
      if (err !== null) {
        mismatches++;
        if (!firstMismatch) firstMismatch = { coords: t, err };
      }
    }
    const ms = performance.now() - t0;
    results.push({ label, cases: tests.length, mismatches, firstMismatch, ms });
  }

  // micro-benchmark the two encoders on identical data (single thread).
  {
    const n = 200000;
    const flat = new Float64Array(n * 12);
    for (let i = 0; i < flat.length; i++) flat[i] = rand(1000);
    let t0 = performance.now();
    for (let i = 0; i < n; i++) ref.encodeTest(flat.subarray(i * 12, i * 12 + 12));
    const slowMs = performance.now() - t0;
    t0 = performance.now();
    for (let i = 0; i < n; i++) ref.encodeTestFast(flat.subarray(i * 12, i * 12 + 12));
    const fastMs = performance.now() - t0;
    report.encoderMicrobench = { n, bigIntEncodeMs: slowMs, fastEncodeMs: fastMs, ratio: slowMs / fastMs };
  }

  report.results = results;
  report.totalMismatches = results.reduce((s, r) => s + r.mismatches, 0);
  return report;
}

// ---- everything below runs inside the browser page -------------------------
async function pageMain({ wgslBase, wgslRaw, CHUNK_SIZE, phase, sizes }) {
  const report = { phase, generatedAt: new Date().toISOString() };
  const FALLBACK = 2;
  const WIDTH = 20; // predicates-raw.wgsl working width in limbs

  if (!('gpu' in navigator)) {
    report.blocker = 'navigator.gpu is undefined in this page context';
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

  async function makeModule(code, name) {
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    const msgs = info.messages.map((m) => `${m.type}: ${m.message} (line ${m.lineNum})`);
    if (msgs.length) report[`shaderCompileMessages_${name}`] = msgs;
    if (info.messages.some((m) => m.type === 'error')) {
      throw new Error(`WGSL module ${name} failed to compile: ${msgs.join('; ')}`);
    }
    return module;
  }

  let baseModule, rawModule;
  try {
    baseModule = await makeModule(wgslBase, 'base');
    rawModule = await makeModule(wgslRaw, 'raw');
  } catch (e) {
    report.blocker = String(e);
    return report;
  }

  const basePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: baseModule, entryPoint: 'main' },
  });
  const o3dRawPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: rawModule, entryPoint: 'orient3dRaw' },
  });
  const icRawPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: rawModule, entryPoint: 'incircleRaw' },
  });
  const mulVarPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: rawModule, entryPoint: 'mulVarSelfTest' },
  });
  const decodePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: rawModule, entryPoint: 'decodeSelfTest' },
  });

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

  function asI32(u) {
    return u > 0x7fffffff ? u - 0x100000000 : u;
  }

  // ---- generators ------------------------------------------------------
  function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }
  function genRandomFlat(n, coordsPer, mag) {
    const arr = new Float64Array(n * coordsPer);
    for (let i = 0; i < arr.length; i++) arr[i] = randRange(-mag, mag);
    return arr;
  }
  function genCoplanarUlpTests(nBases) {
    const tests = [];
    for (let i = 0; i < nBases; i++) {
      const ax = randRange(-1000, 1000), ay = randRange(-1000, 1000), az = randRange(-1000, 1000);
      const bx = randRange(-1000, 1000), by = randRange(-1000, 1000), bz = randRange(-1000, 1000);
      const cx = randRange(-1000, 1000), cy = randRange(-1000, 1000), cz = randRange(-1000, 1000);
      const t1 = randRange(0.2, 0.8), t2 = randRange(0.2, 0.8);
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
  function genExponentSpreadEdgeTests(coordsPer) {
    const tests = [];
    for (const D of [D_MAX - 1, D_MAX, D_MAX + 1, D_MAX + 20, D_MAX + 200]) {
      const tiny = Math.pow(2, -D);
      if (coordsPer === 12) {
        tests.push({ D, test: [0, 0, 0, 1, 0, 0, 0, 1, 0, tiny, tiny, 0] });
        tests.push({ D, test: [0, 0, 0, 1, 0, 0, 0, 1, 0, -tiny, tiny, 0] });
      } else {
        tests.push({ D, test: [0, 0, 1, 0, 0, 1, tiny, tiny] });
        tests.push({ D, test: [0, 0, 1, 0, 0, 1, -tiny, tiny] });
      }
    }
    return tests;
  }
  function genExactZeroTestsO3d() {
    return [
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
      [-0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
      [1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3],
      [1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0],
    ];
  }
  function genSubnormalMixedTests(coordsPer, n) {
    const tests = [];
    for (let i = 0; i < n; i++) {
      const sub = Number.MIN_VALUE * (1 + Math.floor(Math.random() * 10));
      if (coordsPer === 12) tests.push([0, 0, 0, 1, 0, 0, 0, 1, 0, sub, sub, 0]);
      else tests.push([0, 0, 1, 0, 0, 1, sub, sub]);
    }
    return tests;
  }
  function genNanInfTests(coordsPer) {
    const tests = [];
    for (const s of [NaN, Infinity, -Infinity]) {
      for (const pos of coordsPer === 12 ? [0, 5, 11] : [0, 3, 7]) {
        const t = Array.from({ length: coordsPer }, () => randRange(-1000, 1000));
        t[pos] = s;
        tests.push(t);
      }
    }
    return tests;
  }
  // incircle-specific
  function genCocircularUlpTests(nBases) {
    const tests = [];
    for (let i = 0; i < nBases; i++) {
      const cx = randRange(-1000, 1000), cy = randRange(-1000, 1000);
      const r = randRange(1, 1000);
      const pt = () => {
        const t = randRange(0, Math.PI * 2);
        return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
      };
      const base = [...pt(), ...pt(), ...pt(), ...pt()];
      tests.push(base.slice());
      for (let k = 0; k < 8; k++) {
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
  function genExactCocircularInteger(n) {
    // Integer points on the radius-25 circle (Pythagorean 7-24-25 and
    // 15-20-25 triples plus axis points), integer-translated. All
    // arithmetic exact in f64 => determinant exactly zero.
    const P = [
      [25, 0], [-25, 0], [0, 25], [0, -25],
      [7, 24], [24, 7], [-7, 24], [7, -24], [-24, 7], [24, -7], [-7, -24], [-24, -7],
      [15, 20], [20, 15], [-15, 20], [15, -20], [-20, 15], [20, -15], [-15, -20], [-20, -15],
    ];
    const tests = [];
    for (let i = 0; i < n; i++) {
      const idx = [];
      while (idx.length < 4) {
        const k = (Math.random() * P.length) | 0;
        if (!idx.includes(k)) idx.push(k);
      }
      const tx = Math.floor(randRange(-1e6, 1e6));
      const ty = Math.floor(randRange(-1e6, 1e6));
      const t = [];
      for (const k of idx) t.push(P[k][0] + tx, P[k][1] + ty);
      tests.push(t);
    }
    return tests;
  }
  function genDegenerateIC() {
    return [
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 2, 0, 3, 0], // all collinear on the x axis
      [-0, 0, 1, 0, 0, 1, 1, 1], // exact cocircular unit square
      [1, 1, 2, 2, 3, 3, 4, 4], // collinear diagonal
    ];
  }

  // ---- raw-path battery runner ----------------------------------------
  // coordsPer = 12 (orient3d) or 8 (incircle). Uploads EVERY test (no CPU
  // filtering) as raw f64 bits; the GPU decides sign vs FALLBACK sentinel.
  // Expected value per test, computed CPU-side: sentinel iff the frame is
  // invalid (NaN/Inf or D > D_MAX), else the exact BigInt sign.
  async function runRawFlat(coordsFlat, coordsPer, label) {
    const pipeline = coordsPer === 12 ? o3dRawPipeline : icRawPipeline;
    const refFn = coordsPer === 12 ? orient3dSignBigInt : incircleSignBigInt;
    const n = coordsFlat.length / coordsPer;
    let mismatches = 0;
    let gpuFallbacks = 0;
    let expectedFallbacks = 0;
    let checked = 0;
    const mismatchSamples = [];
    let gpuTimeMs = 0;

    for (let chunkStart = 0; chunkStart < n; chunkStart += CHUNK_SIZE) {
      const chunkN = Math.min(CHUNK_SIZE, n - chunkStart);
      const expected = new Int8Array(chunkN);
      for (let i = 0; i < chunkN; i++) {
        const off = (chunkStart + i) * coordsPer;
        const coords = coordsFlat.subarray(off, off + coordsPer);
        const frame = computeFrameN(coords, coordsPer);
        if (!frame.valid) {
          expected[i] = FALLBACK;
          expectedFallbacks++;
        } else {
          expected[i] = refFn(coords);
        }
      }

      const t0 = performance.now();
      const rawView = new Uint32Array(
        coordsFlat.buffer,
        coordsFlat.byteOffset + chunkStart * coordsPer * 8,
        chunkN * coordsPer * 2
      );
      const inBuf = makeBuffer(rawView, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const outBuf = device.createBuffer({
        size: chunkN * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const bindings =
        coordsPer === 12
          ? [
              { binding: 0, buffer: inBuf },
              { binding: 1, buffer: outBuf, isReadback: true },
            ]
          : [
              { binding: 2, buffer: inBuf },
              { binding: 3, buffer: outBuf, isReadback: true },
            ];
      const gpuOut = await dispatchAndRead(pipeline, bindings, Math.ceil(chunkN / 64), chunkN * 4);
      gpuTimeMs += performance.now() - t0;
      inBuf.destroy();
      outBuf.destroy();

      for (let i = 0; i < chunkN; i++) {
        const got = asI32(gpuOut[i]);
        checked++;
        if (got === FALLBACK) gpuFallbacks++;
        if (got !== expected[i]) {
          mismatches++;
          if (mismatchSamples.length < 5) {
            mismatchSamples.push({
              coords: Array.from(coordsFlat.subarray((chunkStart + i) * coordsPer, (chunkStart + i + 1) * coordsPer)),
              expected: expected[i],
              got,
            });
          }
        }
      }
    }

    return { label, totalCases: n, checked, mismatches, gpuFallbacks, expectedFallbacks, gpuTimeMs, mismatchSamples };
  }

  async function runRawArray(testsArray, coordsPer, label) {
    const flat = new Float64Array(testsArray.length * coordsPer);
    testsArray.forEach((t, i) => flat.set(t, i * coordsPer));
    return runRawFlat(flat, coordsPer, label);
  }

  // ---- GPU warmup (forces pipeline compilation out of the timed region) --
  async function warmup() {
    const n = 4096;
    await runRawFlat(genRandomFlat(n, 12, 1000), 12, 'warmup_o3d');
    await runRawFlat(genRandomFlat(n, 8, 1000), 8, 'warmup_ic');
    // base 16-limb pipeline warmup
    const flat = genRandomFlat(n, 12, 1000);
    const words = new Uint32Array(n * WORDS_PER_TEST);
    let valid = 0;
    for (let i = 0; i < n; i++) {
      const enc = encodeTestFast(flat.subarray(i * 12, i * 12 + 12));
      if (enc.valid) {
        words.set(enc.words, valid * WORDS_PER_TEST);
        valid++;
      }
    }
    const inBuf = makeBuffer(words.subarray(0, valid * WORDS_PER_TEST), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const outBuf = device.createBuffer({ size: valid * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    await dispatchAndRead(
      basePipeline,
      [
        { binding: 0, buffer: inBuf },
        { binding: 1, buffer: outBuf, isReadback: true },
      ],
      Math.ceil(valid / 64),
      valid * 4
    );
    inBuf.destroy();
    outBuf.destroy();
  }

  // ---- phase: selftest --------------------------------------------------
  async function runSelfTests() {
    const out = {};

    // 1. length-aware 20-limb multiply vs BigInt (mod 2^640).
    function limbsToBig(limbs) {
      let v = 0n;
      for (let i = limbs.length - 1; i >= 0; i--) v = (v << 32n) | BigInt(limbs[i]);
      return v;
    }
    function bigToLimbs(v, nLimbs) {
      const out = new Uint32Array(nLimbs);
      let x = v & ((1n << BigInt(nLimbs * 32)) - 1n);
      for (let i = 0; i < nLimbs; i++) {
        out[i] = Number(x & 0xffffffffn);
        x >>= 32n;
      }
      return out;
    }
    function randLimbsSparse() {
      // random significant length 0..20 to exercise the length scan
      const limbs = new Uint32Array(WIDTH);
      const len = (Math.random() * (WIDTH + 1)) | 0;
      for (let i = 0; i < len; i++) limbs[i] = (Math.random() * 0x100000000) >>> 0;
      if (len > 0) limbs[len - 1] = limbs[len - 1] || 1; // pin the length
      return limbs;
    }
    const mulCases = [];
    {
      const z = new Uint32Array(WIDTH);
      mulCases.push([z, z]);
      const one = new Uint32Array(WIDTH);
      one[0] = 1;
      mulCases.push([one, z]);
      mulCases.push([one, one]);
      const full = new Uint32Array(WIDTH).fill(0xffffffff);
      mulCases.push([full, full]);
      mulCases.push([full, one]);
      const top = new Uint32Array(WIDTH);
      top[WIDTH - 1] = 0xdeadbeef;
      mulCases.push([top, top]);
      mulCases.push([top, full]);
    }
    for (let i = 0; i < 300; i++) mulCases.push([randLimbsSparse(), randLimbsSparse()]);

    const mulIn = new Uint32Array(mulCases.length * WIDTH * 2);
    mulCases.forEach(([a, b], i) => {
      mulIn.set(a, i * WIDTH * 2);
      mulIn.set(b, i * WIDTH * 2 + WIDTH);
    });
    const mulInBuf = makeBuffer(mulIn, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const mulOutBuf = device.createBuffer({
      size: mulCases.length * WIDTH * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const mulGpuOut = await dispatchAndRead(
      mulVarPipeline,
      [
        { binding: 4, buffer: mulInBuf },
        { binding: 5, buffer: mulOutBuf, isReadback: true },
      ],
      Math.ceil(mulCases.length / 64),
      mulCases.length * WIDTH * 4
    );
    let mulMismatches = 0;
    for (let i = 0; i < mulCases.length; i++) {
      const [a, b] = mulCases[i];
      const expected = bigToLimbs(limbsToBig(a) * limbsToBig(b), WIDTH);
      const got = mulGpuOut.subarray(i * WIDTH, (i + 1) * WIDTH);
      for (let j = 0; j < WIDTH; j++) {
        if (got[j] !== expected[j]) {
          mulMismatches++;
          if (!out.firstMulVarMismatch) {
            out.firstMulVarMismatch = { i, expected: Array.from(expected), got: Array.from(got) };
          }
          break;
        }
      }
    }
    out.mulVar = { cases: mulCases.length, mismatches: mulMismatches };

    // 2. GPU decode/frame/shift vs the trusted CPU encoder, word for word.
    const decTests = [];
    for (let i = 0; i < 20000; i++) decTests.push(Array.from({ length: 12 }, () => randRange(-1000, 1000)));
    for (let i = 0; i < 2000; i++) decTests.push(Array.from({ length: 12 }, () => randRange(-1e9, 1e9)));
    for (let i = 0; i < 2000; i++) decTests.push(Array.from({ length: 12 }, () => randRange(-1e-6, 1e-6)));
    decTests.push(...genCoplanarUlpTests(100));
    decTests.push(...genExactZeroTestsO3d());
    decTests.push(...genSubnormalMixedTests(12, 100));
    decTests.push(...genNanInfTests(12));
    for (const { test } of genExponentSpreadEdgeTests(12)) decTests.push(test);

    const DEC_OUT_STRIDE = 74;
    const decFlat = new Float64Array(decTests.length * 12);
    decTests.forEach((t, i) => decFlat.set(t, i * 12));
    const decView = new Uint32Array(decFlat.buffer);
    const decInBuf = makeBuffer(decView, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const decOutBuf = device.createBuffer({
      size: decTests.length * DEC_OUT_STRIDE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const decGpuOut = await dispatchAndRead(
      decodePipeline,
      [
        { binding: 6, buffer: decInBuf },
        { binding: 7, buffer: decOutBuf, isReadback: true },
      ],
      Math.ceil(decTests.length / 64),
      decTests.length * DEC_OUT_STRIDE * 4
    );
    let decMismatches = 0;
    for (let i = 0; i < decTests.length; i++) {
      const cpu = encodeTest(decTests[i]);
      const o = i * DEC_OUT_STRIDE;
      const gpuValid = decGpuOut[o] === 1;
      let bad = false;
      if (gpuValid !== cpu.valid) bad = true;
      else if (cpu.valid) {
        if (asI32(decGpuOut[o + 1]) !== cpu.eMin) bad = true;
        else {
          for (let w = 0; w < WORDS_PER_TEST; w++) {
            if (decGpuOut[o + 2 + w] !== cpu.words[w]) {
              bad = true;
              break;
            }
          }
        }
      }
      if (bad) {
        decMismatches++;
        if (!out.firstDecodeMismatch) {
          out.firstDecodeMismatch = {
            coords: decTests[i],
            cpuValid: cpu.valid,
            gpuValid,
            cpuEMin: cpu.eMin,
            gpuEMin: asI32(decGpuOut[o + 1]),
          };
        }
      }
    }
    out.decode = { cases: decTests.length, mismatches: decMismatches };

    return out;
  }

  // ---- phase: orient3d raw battery -------------------------------------
  async function runBatteryO3d() {
    const results = [];
    results.push(await runRawFlat(genRandomFlat(1_000_000, 12, 1000), 12, 'random_uniform_1e6_mag1e3'));
    results.push(await runRawFlat(genRandomFlat(200_000, 12, 1e9), 12, 'random_uniform_2e5_mag1e9'));
    results.push(await runRawFlat(genRandomFlat(200_000, 12, 1e-6), 12, 'random_uniform_2e5_mag1e-6'));
    results.push(await runRawArray(genCoplanarUlpTests(2000), 12, 'coplanar_1ulp_perturbations'));
    results.push(await runRawArray(genLastBitDiffTests(50_000), 12, 'last_bit_diff'));
    results.push(await runRawArray(genExactZeroTestsO3d(), 12, 'exact_zeros_and_collinear'));
    results.push(await runRawArray(genSubnormalMixedTests(12, 500), 12, 'subnormal_mixed_must_fallback'));
    results.push(await runRawArray(genNanInfTests(12), 12, 'nan_inf_must_fallback'));
    for (const [D, tests] of groupByD(genExponentSpreadEdgeTests(12))) {
      results.push({ D, ...(await runRawArray(tests, 12, `exponent_spread_D${D}`)) });
    }
    return results;
  }

  // ---- phase: incircle raw battery -------------------------------------
  async function runBatteryIncircle() {
    const results = [];
    results.push(await runRawFlat(genRandomFlat(1_000_000, 8, 1000), 8, 'random_uniform_1e6_mag1e3'));
    results.push(await runRawFlat(genRandomFlat(200_000, 8, 1e9), 8, 'random_uniform_2e5_mag1e9'));
    results.push(await runRawFlat(genRandomFlat(200_000, 8, 1e-6), 8, 'random_uniform_2e5_mag1e-6'));
    results.push(await runRawArray(genCocircularUlpTests(3000), 8, 'cocircular_1ulp_perturbations'));
    results.push(await runRawArray(genExactCocircularInteger(2000), 8, 'exact_cocircular_integer_zero'));
    results.push(await runRawArray(genDegenerateIC(), 8, 'degenerate_zero_and_collinear'));
    results.push(await runRawArray(genSubnormalMixedTests(8, 500), 8, 'subnormal_mixed_must_fallback'));
    results.push(await runRawArray(genNanInfTests(8), 8, 'nan_inf_must_fallback'));
    for (const [D, tests] of groupByD(genExponentSpreadEdgeTests(8))) {
      results.push({ D, ...(await runRawArray(tests, 8, `exponent_spread_D${D}`)) });
    }
    return results;
  }

  function groupByD(edgeCases) {
    const byD = new Map();
    for (const { D, test } of edgeCases) {
      if (!byD.has(D)) byD.set(D, []);
      byD.get(D).push(test);
    }
    return byD;
  }

  // ---- phase: throughput ------------------------------------------------
  //
  // For each n: CPU BigInt baseline, path B (fast CPU encode + 16-limb
  // kernel), path C (raw upload + GPU decode + 20-limb kernel), for
  // orient3d; CPU baseline + path C for incircle. All chunked at
  // CHUNK_SIZE; every path's e2e includes its full CPU-side work, upload,
  // dispatch, readback, and (for path C) the sentinel scan.
  async function runThroughput(sizesList) {
    const rows = [];
    for (const n of sizesList) {
      const row = { n };

      // --- orient3d path C: raw upload + GPU decode ---
      {
        let gpuMs = 0;
        let scanMs = 0;
        let fallbacks = 0;
        for (let chunkStart = 0; chunkStart < n; chunkStart += CHUNK_SIZE) {
          const chunkN = Math.min(CHUNK_SIZE, n - chunkStart);
          const flat = genRandomFlat(chunkN, 12, 1000);
          const t0 = performance.now();
          const rawView = new Uint32Array(flat.buffer, 0, chunkN * 24);
          const inBuf = makeBuffer(rawView, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
          const outBuf = device.createBuffer({
            size: chunkN * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          });
          const gpuOut = await dispatchAndRead(
            o3dRawPipeline,
            [
              { binding: 0, buffer: inBuf },
              { binding: 1, buffer: outBuf, isReadback: true },
            ],
            Math.ceil(chunkN / 64),
            chunkN * 4
          );
          gpuMs += performance.now() - t0;
          inBuf.destroy();
          outBuf.destroy();
          const s0 = performance.now();
          for (let i = 0; i < chunkN; i++) {
            if (gpuOut[i] === FALLBACK) fallbacks++;
          }
          scanMs += performance.now() - s0;
        }
        row.o3dPathC = { gpuMs, scanMs, e2eMs: gpuMs + scanMs, gpuFallbacks: fallbacks };
      }

      // --- orient3d path B: fast CPU encode + 16-limb kernel ---
      {
        let encodeMs = 0;
        let gpuMs = 0;
        let validCount = 0;
        for (let chunkStart = 0; chunkStart < n; chunkStart += CHUNK_SIZE) {
          const chunkN = Math.min(CHUNK_SIZE, n - chunkStart);
          const flat = genRandomFlat(chunkN, 12, 1000);
          const t0 = performance.now();
          const words = new Uint32Array(chunkN * WORDS_PER_TEST);
          let chunkValid = 0;
          for (let i = 0; i < chunkN; i++) {
            const enc = encodeTestFast(flat.subarray(i * 12, i * 12 + 12));
            if (enc.valid) {
              words.set(enc.words, chunkValid * WORDS_PER_TEST);
              chunkValid++;
            }
          }
          encodeMs += performance.now() - t0;
          validCount += chunkValid;
          if (chunkValid > 0) {
            const t1 = performance.now();
            const inBuf = makeBuffer(
              words.subarray(0, chunkValid * WORDS_PER_TEST),
              GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
            );
            const outBuf = device.createBuffer({
              size: chunkValid * 4,
              usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            });
            await dispatchAndRead(
              basePipeline,
              [
                { binding: 0, buffer: inBuf },
                { binding: 1, buffer: outBuf, isReadback: true },
              ],
              Math.ceil(chunkValid / 64),
              chunkValid * 4
            );
            gpuMs += performance.now() - t1;
            inBuf.destroy();
            outBuf.destroy();
          }
        }
        row.o3dPathB = { encodeMs, gpuMs, e2eMs: encodeMs + gpuMs, validCount };
      }

      // --- orient3d CPU BigInt baseline ---
      {
        let cpuMs = 0;
        let touch = 0;
        for (let chunkStart = 0; chunkStart < n; chunkStart += CHUNK_SIZE) {
          const chunkN = Math.min(CHUNK_SIZE, n - chunkStart);
          const flat = genRandomFlat(chunkN, 12, 1000);
          const t0 = performance.now();
          for (let i = 0; i < chunkN; i++) {
            touch += orient3dSignBigInt(flat.subarray(i * 12, i * 12 + 12));
          }
          cpuMs += performance.now() - t0;
        }
        row.o3dCpuBigIntMs = cpuMs;
        row.o3dCpuTouch = touch;
      }
      row.o3dSpeedupPathB = row.o3dCpuBigIntMs / row.o3dPathB.e2eMs;
      row.o3dSpeedupPathC = row.o3dCpuBigIntMs / row.o3dPathC.e2eMs;

      // --- incircle path C ---
      {
        let gpuMs = 0;
        let scanMs = 0;
        let fallbacks = 0;
        for (let chunkStart = 0; chunkStart < n; chunkStart += CHUNK_SIZE) {
          const chunkN = Math.min(CHUNK_SIZE, n - chunkStart);
          const flat = genRandomFlat(chunkN, 8, 1000);
          const t0 = performance.now();
          const rawView = new Uint32Array(flat.buffer, 0, chunkN * 16);
          const inBuf = makeBuffer(rawView, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
          const outBuf = device.createBuffer({
            size: chunkN * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          });
          const gpuOut = await dispatchAndRead(
            icRawPipeline,
            [
              { binding: 2, buffer: inBuf },
              { binding: 3, buffer: outBuf, isReadback: true },
            ],
            Math.ceil(chunkN / 64),
            chunkN * 4
          );
          gpuMs += performance.now() - t0;
          inBuf.destroy();
          outBuf.destroy();
          const s0 = performance.now();
          for (let i = 0; i < chunkN; i++) {
            if (gpuOut[i] === FALLBACK) fallbacks++;
          }
          scanMs += performance.now() - s0;
        }
        row.icPathC = { gpuMs, scanMs, e2eMs: gpuMs + scanMs, gpuFallbacks: fallbacks };
      }

      // --- incircle CPU BigInt baseline ---
      {
        let cpuMs = 0;
        let touch = 0;
        for (let chunkStart = 0; chunkStart < n; chunkStart += CHUNK_SIZE) {
          const chunkN = Math.min(CHUNK_SIZE, n - chunkStart);
          const flat = genRandomFlat(chunkN, 8, 1000);
          const t0 = performance.now();
          for (let i = 0; i < chunkN; i++) {
            touch += incircleSignBigInt(flat.subarray(i * 8, i * 8 + 8));
          }
          cpuMs += performance.now() - t0;
        }
        row.icCpuBigIntMs = cpuMs;
        row.icCpuTouch = touch;
      }
      row.icSpeedupPathC = row.icCpuBigIntMs / row.icPathC.e2eMs;

      rows.push(row);
    }
    return rows;
  }

  // ---- phase: bigrandom -------------------------------------------------
  //
  // Large-scale random battery (chunked generation so total memory stays
  // bounded): sizes[0] orient3d cases + sizes[1] incircle cases, all
  // verified against the CPU BigInt oracle. This is the scale-out toward
  // the 1e8-case exam battery; the bottleneck is the CPU oracle itself
  // (~2.5us per orient3d, ~9us per incircle), not the GPU.
  async function runBigRandom(nO3d, nIc) {
    function aggregate(rs) {
      const agg = { totalCases: 0, checked: 0, mismatches: 0, gpuFallbacks: 0, expectedFallbacks: 0, gpuTimeMs: 0, mismatchSamples: [] };
      for (const r of rs) {
        agg.totalCases += r.totalCases;
        agg.checked += r.checked;
        agg.mismatches += r.mismatches;
        agg.gpuFallbacks += r.gpuFallbacks;
        agg.expectedFallbacks += r.expectedFallbacks;
        agg.gpuTimeMs += r.gpuTimeMs;
        agg.mismatchSamples.push(...r.mismatchSamples.slice(0, 5 - agg.mismatchSamples.length));
      }
      return agg;
    }
    const o3dRuns = [];
    for (let done = 0; done < nO3d; done += CHUNK_SIZE) {
      const chunkN = Math.min(CHUNK_SIZE, nO3d - done);
      // rotate magnitude regimes so scale coverage is not mag-1e3 only
      const mag = [1000, 1e9, 1e-6][(done / CHUNK_SIZE) % 3];
      o3dRuns.push(await runRawFlat(genRandomFlat(chunkN, 12, mag), 12, `chunk_mag${mag}`));
    }
    const icRuns = [];
    for (let done = 0; done < nIc; done += CHUNK_SIZE) {
      const chunkN = Math.min(CHUNK_SIZE, nIc - done);
      const mag = [1000, 1e9, 1e-6][(done / CHUNK_SIZE) % 3];
      icRuns.push(await runRawFlat(genRandomFlat(chunkN, 8, mag), 8, `chunk_mag${mag}`));
    }
    return { orient3d: aggregate(o3dRuns), incircle: aggregate(icRuns) };
  }

  await warmup();

  if (phase === 'bigrandom') {
    report.bigRandom = await runBigRandom(sizes[0], sizes[1] ?? Math.floor(sizes[0] / 4));
  }
  if (phase === 'selftest' || phase === 'all') {
    report.selfTests = await runSelfTests();
  }
  if (phase === 'battery' || phase === 'all') {
    report.batteryOrient3d = await runBatteryO3d();
  }
  if (phase === 'incircle' || phase === 'all') {
    report.batteryIncircle = await runBatteryIncircle();
  }
  if (phase === 'throughput' || phase === 'all') {
    report.throughput = await runThroughput(sizes);
  }

  return report;
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
