/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Out-of-core ingest (`?perf.ooc=1`) across the real wasm boundary.
 *
 * Each fixture is meshed twice from one streaming pre-pass, in the same
 * batches: once the way a whole-file worker does (`setSourceBytes`,
 * `setEntityIndex`, `processGeometryBatch[Partitioned]FromSource`), the
 * reference, and once the way an out-of-core worker does: a
 * `WorkerSparseSession` (the worker's own class, from the geometry build) over
 * a sparse arena fed by range reads against the shared index. The contract:
 *
 * - without `setEmitSparseFacts` the pre-pass emits no `sparse-facts` event;
 * - every batch's meshes are byte-identical to the reference (id, type,
 *   positions, normals, indices, colour, origin), in the same order, and so is
 *   its instancing shard;
 * - that holds when the arena budget is far below the file, so the arena is
 *   dropped and refilled many times;
 * - the sparse worker reads the file by range only: it never installs the
 *   source or an entity index;
 * - a sparse batch outside a session throws instead of returning nothing;
 * - a file that reuses an entity id is named unsupported by the pre-pass.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The runner must start with only the wasm package built: the geometry build is imported when present.
const SESSION = fileURLToPath(new URL('../../packages/geometry/dist/geometry-worker-sparse.js', import.meta.url));
const BUILT = existsSync(SESSION);
const { WorkerSparseSession } = BUILT ? await import('../../packages/geometry/dist/geometry-worker-sparse.js') : {};

const FIXTURES = [
  { path: 'rust/geometry/tests/fixtures/issue_1910_building_shell_geometry.ifc', committed: true },
  { path: 'tests/models/ara3d/AC20-FZK-Haus.ifc' },
  { path: 'tests/models/ara3d/duplex.ifc' },
];
const JOBS_PER_BATCH = 16;
const MIB = 1024 * 1024;

/** The streaming pre-pass events a pool forwards to its workers, by type. */
function prepass(IfcAPI, bytes, sparseFacts) {
  const api = new IfcAPI();
  try {
    if (sparseFacts) api.setEmitSparseFacts(true);
    const events = { jobs: [] };
    api.buildPrePassStreaming(bytes, (event) => {
      if (event.type === 'jobs') events.jobs.push(event.jobs);
      else events[event.type] = event;
    }, 50_000, undefined, false);
    return events;
  } finally {
    api.clearPrePassCache?.();
    api.free();
  }
}

/** What a worker installs from the `prepass-columns` event (geometry.worker.ts `applyPrepassColumnsToApi`). */
function installColumns(api, columns) {
  if (!columns) return;
  api.setReferencedRepmaps(columns.referencedRepmaps);
  api.setInstantiatedTypeIds(columns.instantiatedTypeIds);
  if (columns.mappedInstancePlan) api.setMappedInstancePlan(columns.mappedInstancePlan);
  api.setMaterialLayerIndex(
    columns.mliElementIds, columns.mliAxis, columns.mliLayerCounts, columns.mliDirectionSense,
    columns.mliOffset, columns.mliLayerMaterialIds, columns.mliLayerThicknesses,
  );
}

/** Every mesh of a collection as comparable bytes; frees the collection. */
function drain(collection) {
  const meshes = [];
  try {
    for (let i = 0; i < collection.length; i++) {
      const mesh = collection.get(i);
      try {
        meshes.push({
          expressId: mesh.expressId, ifcType: mesh.ifcType,
          positions: mesh.positions, normals: mesh.normals, indices: mesh.indices,
          color: Array.from(mesh.color), origin: mesh.origin ? Array.from(mesh.origin) : null,
        });
      } finally {
        mesh.free();
      }
    }
  } finally {
    collection.free();
  }
  return meshes;
}

/** A partitioned batch as comparable parts; frees it. */
function drainPartitioned(partitioned) {
  try {
    const collection = partitioned.takeMeshes();
    return { meshes: collection ? drain(collection) : [], shard: partitioned.takeShard(), occurrences: partitioned.instancedOccurrences };
  } finally {
    partitioned.free();
  }
}

function sameBytes(actual, expected, what) {
  assert.equal(actual.constructor, expected.constructor, `${what}: array type`);
  assert.equal(actual.length, expected.length, `${what}: length`);
  assert.equal(Buffer.compare(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength), Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength)), 0, `${what}: bytes differ`);
}

function sameMeshes(actual, expected, where) {
  assert.equal(actual.length, expected.length, `${where}: mesh count`);
  expected.forEach((want, i) => {
    const got = actual[i];
    const what = `${where} mesh ${i} (#${want.expressId})`;
    assert.equal(got.expressId, want.expressId, `${what}: order`);
    assert.equal(got.ifcType, want.ifcType, `${what}: type`);
    assert.deepEqual(got.color, want.color, `${what}: colour`);
    assert.deepEqual(got.origin, want.origin, `${what}: origin`);
    sameBytes(got.positions, want.positions, `${what} positions`);
    sameBytes(got.normals, want.normals, `${what} normals`);
    sameBytes(got.indices, want.indices, `${what} indices`);
  });
}

function checkFixture(IfcAPI, bytes) {
  assert.equal(prepass(IfcAPI, bytes, false)['sparse-facts'], undefined, 'no sparse-facts event unless asked');
  const events = prepass(IfcAPI, bytes, true);
  const { meta, styles } = events;
  const index = events['entity-index'];
  const facts = events['sparse-facts'];
  assert.ok(meta && styles && index && facts, 'the pre-pass emitted meta, styles, entity-index and sparse-facts');
  assert.equal(facts.unsupported, undefined, 'the scan names nothing an arena cannot serve in this fixture');
  const jobs = Uint32Array.from(events.jobs.flatMap((chunk) => Array.from(chunk)));
  assert.ok(jobs.length > 0, 'the fixture has geometry jobs');
  const [rx, ry, rz] = meta.rtcOffset ? Array.from(meta.rtcOffset) : [0, 0, 0];
  const argsFor = (batch) => [
    batch, meta.unitScale, rx || 0, ry || 0, rz || 0, meta.needsShift,
    styles.voidKeys, styles.voidCounts, styles.voidValues, styles.styleIds, styles.styleColors,
    meta.planeAngleToRadians, styles.materialElementIds, styles.materialColorCounts, styles.materialColors,
  ];
  const batches = [];
  for (let at = 0; at < jobs.length; at += JOBS_PER_BATCH * 3) batches.push(jobs.subarray(at, at + JOBS_PER_BATCH * 3));

  // The whole-file worker.
  const full = new IfcAPI();
  full.setEntityIndex(index.ids, index.starts, index.lengths);
  installColumns(full, events['prepass-columns']);
  full.setSourceBytes(bytes);
  const reference = batches.map((batch) => ({
    flat: drain(full.processGeometryBatchFromSource(...argsFor(batch))),
    partitioned: drainPartitioned(full.processGeometryBatchPartitionedFromSource(...argsFor(batch))),
  }));
  full.free();
  const meshCount = reference.reduce((sum, batch) => sum + batch.flat.length, 0);
  assert.ok(meshCount > 0, 'the reference meshed something');

  // A sparse batch outside a session is refused: an empty result would read as a batch that meshed nothing.
  const idle = new IfcAPI();
  assert.throws(() => idle.processGeometryBatchSparse(...argsFor(batches[0])), /no sparse session/);
  assert.throws(() => idle.processGeometryBatchPartitionedSparse(...argsFor(batches[0])), /no sparse session/);
  idle.free();

  const sharedBuffer = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(sharedBuffer).set(bytes);
  const result = { meshes: meshCount, batches: batches.length };
  // The default budget, and one far below the file so the arena is dropped and refilled.
  for (const budgetBytes of [192 * MIB, Math.max(4096, Math.floor(bytes.byteLength / 16))]) {
    const sparse = new IfcAPI();
    const session = new WorkerSparseSession({
      type: 'set-sparse-source', sharedBuffer, preamble: facts.preamble,
      inverseTargets: facts.inverseTargets, inverseReferrers: facts.inverseReferrers,
      indexIds: index.ids, indexStarts: index.starts, indexLengths: index.lengths, budgetBytes,
    });
    session.applyTo(sparse);
    installColumns(sparse, events['prepass-columns']);
    batches.forEach((batch, b) => {
      const where = `budget ${budgetBytes} batch ${b}`;
      sameMeshes(drain(session.mesh(sparse, argsFor(batch), false)), reference[b].flat, `${where} flat`);
      const partitioned = drainPartitioned(session.mesh(sparse, argsFor(batch), true));
      sameMeshes(partitioned.meshes, reference[b].partitioned.meshes, `${where} partitioned`);
      sameBytes(partitioned.shard, reference[b].partitioned.shard, `${where} instancing shard`);
      assert.equal(partitioned.occurrences, reference[b].partitioned.occurrences, `${where}: instanced occurrences`);
    });
    sparse.sparseEnd();
    sparse.free();
    assert.ok(session.stats.bytesRead > 0, 'the sparse worker read the file by range');
    if (budgetBytes < 192 * MIB) {
      result.resets = session.stats.resets;
      result.retries = session.stats.retries;
      result.readRatio = session.stats.bytesRead / bytes.byteLength;
    } else {
      assert.equal(session.stats.resets, 0, 'a fixture this small never fills the default arena');
    }
  }
  return result;
}

export function runOutOfCoreContracts(IfcAPI, test, skip, rootDir) {
  test('out-of-core: a file that reuses an entity id is named unsupported by the pre-pass', () => {
    const step = (records) => new TextEncoder().encode(`ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${records}\nENDSEC;\nEND-ISO-10303-21;\n`);
    const unique = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((0.,0.,1.));";
    assert.equal(prepass(IfcAPI, step(unique), true)['sparse-facts']?.unsupported, undefined);
    const reused = `${unique}\n#2=IFCDIRECTION((1.,0.,0.));`;
    assert.match(prepass(IfcAPI, step(reused), true)['sparse-facts'].unsupported, /reused/);
  });
  for (const fixture of FIXTURES) {
    const path = join(rootDir, fixture.path);
    const name = `out-of-core: ${fixture.path.split('/').pop()} meshes byte-identical to the whole-file worker`;
    if (!BUILT) {
      skip(name, 'packages/geometry is not built — run `pnpm build`');
      continue;
    }
    if (!existsSync(path)) {
      assert.ok(!fixture.committed, `${fixture.path} is committed and must exist`);
      skip(name, 'fixture missing — run `pnpm fixtures`');
      continue;
    }
    test(name, () => {
      const result = checkFixture(IfcAPI, readFileSync(path));
      console.log(`     ${result.meshes} meshes in ${result.batches} batches; small arena: ${result.resets} resets, ${result.retries} retries, read ${result.readRatio.toFixed(2)}x the file`);
    });
  }
}
