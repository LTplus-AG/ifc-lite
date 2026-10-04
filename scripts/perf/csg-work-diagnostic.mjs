// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6516 source-prepared diagnostic ONLY: positive wrapper observations, not timing.
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
export const bounds = Object.freeze({ recordsPerDrain: 16_384, jobs: 4_096,
  reportBytes: 16 * 1024 * 1024 });
class DiagnosticRefusal extends Error {}
const refuse = reason => { throw new DiagnosticRefusal(reason); };
const uint32 = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;

/** Validate the separate ordered-tuple ABI; never aggregate it as numeric counters. */
export function observedEntries(value) {
  if (!Array.isArray(value) || value.length > bounds.recordsPerDrain) refuse('INVALID_CENSUS_POPULATION');
  return value.map(row => {
    if (!Array.isArray(row) || row.length !== 3 || !row.every(uint32) || row[0] > 3) {
      refuse('INVALID_CENSUS_TUPLE');
    }
    return [...row];
  });
}

/** Key the ACTUAL original batch triple; identical triples preserve repeated rows. */
export function sourceJob(jobs, index, source) {
  if (!(jobs instanceof Uint32Array) || jobs.length % 3 !== 0
    || !Number.isSafeInteger(index) || index < 0 || index % 3 !== 0 || index + 3 > jobs.length
    || !source || !/^[a-f0-9]{64}$/.test(source.sha256)
    || !Number.isSafeInteger(source.bytes) || source.bytes < 1) refuse('INVALID_SOURCE_JOB_BINDING');
  const triple = Array.from(jobs.subarray(index, index + 3));
  if (!triple.every(uint32) || triple[0] === 0 || triple[1] >= triple[2]
    || triple[2] > source.bytes) refuse('INVALID_SOURCE_JOB_SPAN');
  const protocol = 'source-job-triple-v1';
  return { sourceJobTriple: triple, sourceJobKeyProtocol: protocol,
    sourceJobKey: sha(JSON.stringify([protocol, source.sha256, ...triple])) };
}

const limits = Object.freeze({
  completeness: 'UNVERIFIED', operandCountTruncation: 'UNVERIFIED', lockHealth: 'UNVERIFIED',
  emptyArrayMeaning: 'NOT_PROOF_OF_ZERO_WORK', recordingWithinCall: 'EXISTING_UNBOUNDED_VECTOR',
  observation: 'RECORDED_WRAPPER_ENTRIES_NOT_UNIFORM_KERNEL_INVOCATIONS',
  outputOfEachCsgOperation: 'UNAVAILABLE', routes: 'UNAVAILABLE', errors: 'UNAVAILABLE',
  predicateCost: 'UNAVAILABLE', timingVerdict: 'UNAVAILABLE', privateCause: 'UNPROVEN',
});

export function completePopulation() {
  const rows = [];
  const occurrences = new Map();
  let retainedBytes = 0;
  let observedJobs = 0;
  let failure;
  return {
    rows,
    add(row) {
      observedJobs++;
      if (failure) refuse(failure);
      // Keep source tuple multiplicity and raw24 output scope; omit replay clocks.
      const duplicateOccurrence = occurrences.get(row.sourceJobKey) ?? 0;
      const publicRow = { ordinal: row.ordinal, duplicateOccurrence, sourceJobTriple: row.sourceJobTriple,
        sourceJobKey: row.sourceJobKey, sourceJobKeyProtocol: row.sourceJobKeyProtocol,
        meshes: row.meshes, triangles: row.triangles, outputDigestProtocol: 'raw-mesh-24-v1',
        raw24MeshMultisetSha256: row.raw24MeshMultisetSha256,
        observedWrapperEntries: observedEntries(row.counters) };
      const bytes = Buffer.byteLength(JSON.stringify(publicRow), 'utf8') + 1;
      // Reserve 16KiB for bounded top-level labels, pins and error status.
      if (observedJobs > bounds.jobs || retainedBytes + bytes > bounds.reportBytes - 16_384) {
        failure = 'OBSERVED_JOB_REPORT_BOUND_EXCEEDED'; refuse(failure);
      }
      retainedBytes += bytes;
      occurrences.set(row.sourceJobKey, duplicateOccurrence + 1);
      rows.push(publicRow);
    },
    status: () => ({ observedJobs, retainedJobs: rows.length, retainedRowBytes: retainedBytes,
      observedRowsRetainedWithoutClipping: !failure, refusal: failure ?? null }),
  };
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
export function observeBatches(api, takeCounters, onJob, onBatch, source) {
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
            triangles: output.triangles, counters,
            ...sourceJob(jobs, index, source),
            raw24MeshMultisetSha256: combined(output.hashes) });
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

/** Ordinary mode observes the same collection and transfers its original ownership. */
export function observeOriginalBatches(api, onBatch) {
  const original = api.processGeometryBatch;
  api.processGeometryBatch = function (...args) {
    let collection;
    try {
      collection = original.apply(this, args);
      onBatch(fingerprintCollection(collection));
      const result = collection;
      collection = undefined;
      return result;
    } finally { collection?.free(); }
  };
  return () => { api.processGeometryBatch = original; };
}

/** EXACT prior stream-diagnostic per-mesh recipe, applied during this same load. */
export function fingerprintConvertedMeshes(meshes) {
  const hashes = [];
  let triangles = 0;
  for (const mesh of meshes) {
    const hash = createHash('sha256');
    hash.update(JSON.stringify([mesh.expressId, mesh.origin ?? null, mesh.color]));
    for (const key of ['positions', 'normals', 'indices']) {
      const array = mesh[key];
      hash.update(JSON.stringify([key, array.constructor.name, array.byteLength]));
      hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
    }
    hashes.push(hash.digest('hex'));
    triangles += mesh.indices.length / 3;
  }
  return { hashes, triangles };
}

export async function diagnoseCsgWork(modelPath, { cwd = process.cwd(), mode = 'diagnostic' } = {}) {
  if (!['ordinary', 'diagnostic'].includes(mode)) refuse('UNKNOWN_READER_MODE');
  const require = createRequire(join(resolve(cwd), 'package.json'));
  const geometryEntry = require.resolve('@ifc-lite/geometry');
  const wasmRequire = createRequire(geometryEntry);
  const wasmEntry = wasmRequire.resolve('@ifc-lite/wasm');
  const wasmBinary = wasmRequire.resolve('@ifc-lite/wasm/ifc-lite_bg.wasm');
  const wasm = await import(pathToFileURL(wasmEntry));
  const provenance = { geometryEntrySha256: sha(await readFile(geometryEntry)),
    wasmGlueSha256: sha(await readFile(wasmEntry)), wasmSha256: sha(await readFile(wasmBinary)) };
  const base = { schemaVersion: 'csg-work-positive-observation-v1', diagnosticOnly: true,
    interpretation: 'POSITIVE_ONLY_NO_ABSENCE_EXACT_WORK_DELTA_OR_CAUSAL_RATIO',
    operationEncoding: { 0: 'subtract', 1: 'union', 2: 'intersection', 3: 'clip' },
    mode, recordedOperandCounts: mode === 'diagnostic' ? 'EXISTING_U32_CAST_COUNTS' : 'UNAVAILABLE',
    limits, node: process.version, ...provenance };
  if (mode === 'diagnostic' && typeof wasm.takeCsgWorkCensus !== 'function') return { ...base, status: 'UNAVAILABLE',
    reason: 'DIAGNOSTIC_FEATURE_EXPORT_ABSENT' };
  const { GeometryProcessor } = await import(pathToFileURL(geometryEntry));
  const bytes = new Uint8Array(await readFile(modelPath));
  // Exactly once, before existing observer job clocks and replay calls.
  const source = { sha256: sha(bytes), bytes: bytes.byteLength };
  const population = completePopulation();
  const processor = new GeometryProcessor();
  const hashes = [];
  const convertedHashes = [];
  let convertedTriangles = 0;
  let convertedBatches = 0;
  let triangles = 0;
  let referenceBatches = 0;
  let completeEvents = 0;
  let restore;
  let failure;
  const census = () => observedEntries(wasm.takeCsgWorkCensus());
  try {
    await processor.init();
    const api = processor.getApi();
    if (!api) refuse('GEOMETRY_API_UNAVAILABLE');
    const onBatch = output => {
      referenceBatches++; hashes.push(...output.hashes); triangles += output.triangles;
    };
    restore = mode === 'ordinary' ? observeOriginalBatches(api, onBatch)
      : observeBatches(api, census, row => population.add(row), onBatch, source);
    for await (const event of processor.processStreaming(bytes)) {
      if (event.type === 'error') refuse('CANONICAL_STREAM_ERROR');
      if (event.type === 'complete') completeEvents++;
      if (event.type === 'batch') {
        const output = fingerprintConvertedMeshes(event.meshes);
        convertedHashes.push(...output.hashes); convertedTriangles += output.triangles;
        convertedBatches++;
      }
      // Continue to normal generator exhaustion, preserving its final cleanup.
    }
    if (completeEvents !== 1) refuse('CANONICAL_COMPLETE_EVENT_COUNT_INVALID');
    if (hashes.length !== convertedHashes.length || triangles !== convertedTriangles) {
      refuse('RAW_AND_CONVERTED_OUTPUT_COUNT_MISMATCH');
    }
  } catch (error) {
    failure = error instanceof DiagnosticRefusal ? error.message : 'SDK_EXECUTION_FAILED_PRIVATE_ERROR_WITHHELD';
  } finally {
    restore?.();
    processor.dispose?.();
  }
  const status = population.status();
  const report = { ...base, status: failure ? 'REFUSED' : mode === 'ordinary' ? 'ORDINARY_OUTPUT_OBSERVATION' : 'POSITIVE_OBSERVATION',
    reason: failure ?? null, sourceContentSha256: source.sha256, fileBytes: source.bytes,
    sourceContentBinding: 'ORIGINAL_FILE_BYTES_PASSED_TO_CANONICAL_SDK_ARGS0_NOT_INDEPENDENTLY_HASHED',
    canonicalCompleteEvents: completeEvents,
    canonicalBatchIdentity: mode === 'diagnostic' ? !failure : 'UNAVAILABLE_NO_REPLAYS',
    observedPopulation: mode === 'ordinary' ? 'UNAVAILABLE_NO_REPLAYS'
      : { ...status, observedRowsRetainedWithoutClipping: !failure && status.observedRowsRetainedWithoutClipping,
        readerPopulationStatus: failure ? 'INCOMPLETE_REFUSED' : 'ALL_OBSERVED_ROWS_RETAINED' },
    jobs: population.rows,
    executionAccounting: { canonicalSdkStreamCalls: 1, ordinaryReferenceBatchesCompleted: referenceBatches,
      extraIndividualWasmBatchReplaysCompleted: status.retainedJobs,
      failedOrUnreportedReplayAttempts: failure ? 'UNAVAILABLE' : 0 },
    meshDigestProtocol: 'raw-mesh-24-v1', meshFields,
    meshes: hashes.length, triangles, raw24MeshMultisetSha256: combined(hashes),
    convertedMeshProtocol: 'stock-converted-mesh-6-v1', convertedMeshes: convertedHashes.length,
    convertedTriangles, convertedBatches, convertedMeshMultisetSha256: combined(convertedHashes) };
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > bounds.reportBytes) {
    refuse('FINAL_REPORT_BYTE_BOUND_EXCEEDED');
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || !['ordinary', 'diagnostic'].includes(process.argv[2])) {
    throw new Error('Usage: node csg-work-diagnostic.mjs <ordinary|diagnostic> <model.ifc>');
  }
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(methods.map(key => [key, console[key]]));
  const libraryLogLines = Object.fromEntries(methods.map(key => [key, 0]));
  let report;
  try {
    for (const key of methods) console[key] = () => { libraryLogLines[key]++; };
    report = await diagnoseCsgWork(process.argv[3], { mode: process.argv[2] });
  } catch (error) {
    report = { schemaVersion: 'csg-work-positive-observation-v1', diagnosticOnly: true,
      status: 'REFUSED', reason: error instanceof DiagnosticRefusal ? error.message
        : 'SDK_EXECUTION_FAILED_PRIVATE_ERROR_WITHHELD', limits };
  } finally {
    for (const key of methods) console[key] = originals[key];
  }
  if (!['POSITIVE_OBSERVATION', 'ORDINARY_OUTPUT_OBSERVATION'].includes(report.status)) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ ...report, libraryLogLines })}\n`);
}
