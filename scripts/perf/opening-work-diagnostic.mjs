// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6516 actual route work. Diagnostic only: NOT a worker-pool benchmark.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const meshFields = [
  'expressId', 'ifcType', 'geometryClass', 'geometryItemId', 'materialId',
  'positions', 'normals', 'indices', 'color', 'shadingColor', 'origin',
  'localBounds', 'localToWorld', 'metallic', 'roughness', 'uvs',
  'hasTexture', 'textureId', 'textureUrl', 'textureRgba', 'textureWidth',
  'textureHeight', 'textureRepeatS', 'textureRepeatT',
];
const sha = value => createHash('sha256').update(value).digest('hex');
const combined = hashes => sha([...hashes].sort().join('\n'));

/** Aggregate #6537 job work: probe distances are maxima; other counters add. */
export function aggregateOpeningCounters(totals, counters) {
  let precisionLimited = false;
  const combine = (a, b, maximum = false) => {
    const result = maximum ? Math.max(a, b) : a + b;
    if (!Number.isSafeInteger(b) || !Number.isSafeInteger(result)) precisionLimited = true;
    return Math.min(Number.MAX_SAFE_INTEGER, result);
  };
  for (const [key, value] of Object.entries(counters)) {
    if (Array.isArray(value)) {
      totals[key] ??= value.map(() => 0);
      value.forEach((n, i) => { totals[key][i] = combine(totals[key][i], n); });
    } else {
      const maximum = key === 'ringSimplifierMaxPrevProbeDistance'
        || key === 'ringSimplifierMaxNextProbeDistance';
      totals[key] = combine(totals[key] ?? 0, value, maximum);
    }
  }
  return precisionLimited;
}

/** Read copies, free each temporary handle, retain the caller's collection. */
export function fingerprintCollection(collection) {
  const hashes = [];
  let triangles = 0;
  for (let i = 0; i < collection.length; i++) {
    const mesh = collection.get(i);
    if (!mesh) continue;
    try {
      const hash = createHash('sha256');
      for (const key of meshFields) {
        const value = mesh[key];
        hash.update(JSON.stringify(key));
        if (ArrayBuffer.isView(value)) {
          hash.update(JSON.stringify([value.constructor.name, value.byteLength]));
          hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
          if (key === 'indices') triangles += value.length / 3;
        } else {
          hash.update(JSON.stringify(value) ?? 'undefined');
        }
      }
      hashes.push(hash.digest('hex'));
    } finally { mesh.free(); }
  }
  return { hashes, triangles };
}

/**
 * Observe the ordinary stream's exact batch arguments and original job slices.
 * Return its ORIGINAL collection, so streaming still owns conversion and free.
 * Extra individual jobs are independently freed and must reproduce that batch.
 */
export function observeBatches(api, takeCounters, onJob, onBatch) {
  const original = api.processGeometryBatch;
  let ordinal = 0;
  api.processGeometryBatch = function (...args) {
    let reference;
    try {
      takeCounters();
      reference = original.apply(this, args);
      takeCounters(); // Exclude reference work from the individual job census.
      const expected = fingerprintCollection(reference);
      const actualHashes = [];
      let actualTriangles = 0;
      const jobs = args[1];
      if (jobs.length % 3 !== 0) throw new Error('Unexpected geometry job layout');
      for (let index = 0; index < jobs.length; index += 3) {
        const jobArgs = [...args];
        jobArgs[1] = jobs.slice(index, index + 3);
        let collection;
        takeCounters();
        const start = performance.now();
        try {
          collection = original.apply(this, jobArgs);
          const elapsedMs = performance.now() - start;
          const counters = takeCounters();
          const output = fingerprintCollection(collection);
          actualHashes.push(...output.hashes);
          actualTriangles += output.triangles;
          onJob({ ordinal: ordinal++, elapsedMs, meshes: output.hashes.length,
            triangles: output.triangles, counters });
        } finally { collection?.free(); }
      }
      const matches = expected.triangles === actualTriangles
        && expected.hashes.length === actualHashes.length
        && combined(expected.hashes) === combined(actualHashes);
      if (!matches) throw new Error('Individual jobs differ from canonical streaming batch');
      onBatch(expected);
      const result = reference;
      reference = undefined; // Transfer ownership back to ordinary streaming.
      return result;
    } finally { reference?.free(); }
  };
  return () => { api.processGeometryBatch = original; };
}

export async function diagnoseOpeningWork(modelPath, { cwd = process.cwd() } = {}) {
  const require = createRequire(join(resolve(cwd), 'package.json'));
  const geometryEntry = require.resolve('@ifc-lite/geometry');
  const wasmRequire = createRequire(geometryEntry);
  const wasmEntry = wasmRequire.resolve('@ifc-lite/wasm');
  const wasmBinary = wasmRequire.resolve('@ifc-lite/wasm/ifc-lite_bg.wasm');
  const wasm = await import(pathToFileURL(wasmEntry));
  if (typeof wasm.takeOpeningPerfCounters !== 'function') {
    throw new Error('Build the diagnostic opening-perf-trace feature first');
  }
  const { GeometryProcessor } = await import(pathToFileURL(geometryEntry));
  const bytes = new Uint8Array(await readFile(modelPath));
  const processor = new GeometryProcessor();
  const hottest = [];
  const work = [];
  const totals = {};
  const hashes = [];
  let jobs = 0;
  let triangles = 0;
  let counterPrecisionLimited = false;
  let restore;
  const retain = (rows, row) => {
    rows.push(row);
    rows.sort((a, b) => b.elapsedMs - a.elapsedMs || a.ordinal - b.ordinal);
    if (rows.length > 50) rows.pop();
  };
  try {
    await processor.init();
    const api = processor.getApi();
    if (!api) throw new Error('Geometry API unavailable');
    restore = observeBatches(api, wasm.takeOpeningPerfCounters, row => {
      jobs++;
      retain(hottest, row);
      if (row.counters.unionRetries || row.counters.stagedMixedAttempts) retain(work, row);
      const limited = aggregateOpeningCounters(totals, row.counters);
      counterPrecisionLimited ||= limited;
    }, output => { hashes.push(...output.hashes); triangles += output.triangles; });
    // Same loader, prepass, style finishes, tessellation, RTC and local-frame
    // choices as ordinary Node processStreaming. Flat collection path only;
    // this does not exercise browser worker scheduling or instancing.
    for await (const event of processor.processStreaming(bytes)) {
      if (event.type === 'error') throw new Error('Geometry stream failed');
    }
  } finally {
    restore?.();
    processor.dispose?.();
  }
  return {
    schemaVersion: 1, diagnosticOnly: true, node: process.version,
    geometryEntrySha256: sha(await readFile(geometryEntry)),
    wasmGlueSha256: sha(await readFile(wasmEntry)),
    wasmSha256: sha(await readFile(wasmBinary)),
    fileBytes: bytes.byteLength,
    canonicalBatchIdentity: true,
    meshFields,
    meshes: hashes.length, triangles, meshBytesSha256: combined(hashes), jobs,
    totals, counterPrecisionLimited, hottestJobs: hottest, expensiveRouteJobs: work,
    retainedJobsPerList: 50,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node opening-work-diagnostic.mjs <model.ifc>');
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map(key => [key, console[key]]));
  const libraryLogLines = Object.fromEntries(methods.map(key => [key, 0]));
  let report;
  try {
    for (const key of methods) console[key] = () => { libraryLogLines[key]++; };
    report = await diagnoseOpeningWork(process.argv[2]);
  } catch {
    // Library exceptions may contain private source text. Report only failure.
    report = { diagnosticOnly: true, failed: true };
    process.exitCode = 1;
  } finally {
    for (const key of methods) console[key] = originals[key];
  }
  process.stdout.write(`${JSON.stringify({ ...report, libraryLogLines }, null, 2)}\n`);
}
