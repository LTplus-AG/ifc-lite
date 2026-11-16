#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Cross-language conformance of the native `.ifclite` writer (`rust/cache`,
 * #9584) against `@ifc-lite/cache`, the format's TypeScript reader and writer.
 *
 * Per fixture, the Rust writer builds the cache (`--example
 * conformance_writer`) and this script asserts the four agreed properties:
 *
 *  1. Self-reproducible: the native bytes are identical under
 *     RAYON_NUM_THREADS=1 and the default pool.
 *  2. Scalar sections: the TS writer, handed the SAME model (the one the
 *     native cache encodes, as the TS reader decodes it), emits the header
 *     and Strings / Entities / Properties / Quantities / Relationships /
 *     EntityIndex byte-identical to the native writer.
 *  3. Geometry: every directory field but the stored byteOffset/byteLength
 *     equal, every chunk's uncompressed payload byte-identical, every decoded
 *     mesh record equal. The deflate streams differ (miniz_oxide vs node
 *     zlib); each side's storage is checked against the inflated payload,
 *     and a DeflateRaw flag that differs is allowed only where both sides
 *     followed the store-iff-strictly-smaller rule.
 *  4. The TS reader accepts the native cache, including `read({ sourceBuffer
 *     })` hash validation, and refuses truncated, bad-magic, wrong-version
 *     and corrupt-chunk-length variants of it.
 *
 * Besides byte equality, the decoded values are checked against the TS
 * libraries' own tables (`IfcTypeEnumFromString`, `IFC_ENTITY_NAMES`,
 * `relationshipTypeName`) and the source spans, so a value both writers
 * would encode identically but that is wrong still fails.
 *
 * Because 2 and 3 hand the TS writer the native model, a value dropped before
 * encoding would survive them. Two independent oracles close that:
 *
 *  5. Data model: the same IFC parsed by the TS parser
 *     (`lib/cache-native-model-oracle.mjs`): attributes per express id
 *     (absent vs empty), types, every relationship edge, schema, units, and
 *     the row-set difference as an asserted rule.
 *  6. Geometry: the canonical `ifc_lite_processing::process` output, dumped
 *     by `--example processing_oracle` (no writer code), converted to the
 *     viewer frame here (`lib/cache-native-geometry-oracle.mjs`): every mesh
 *     field, world coordinates against `MeshFrame::to_world` in every frame
 *     tier (a rotated IfcSite included), CoordinateInfo against the browser
 *     pre-pass's resolvers; plus known world corners for a synthetic
 *     rotated site.
 *
 * Neither claims browser equivalence for what the native cache leaves absent;
 * those are printed as limitations on every run.
 *
 * Needs cargo and built `@ifc-lite/cache`, `@ifc-lite/data` and
 * `@ifc-lite/parser` (`pnpm build`). Runs in the Build job of
 * `.github/workflows/test.yml`, where the catalogued fixtures are fetched and
 * `IFC_LITE_REQUIRE_FIXTURES=1` makes an absent one a failure.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareDecodedModel } from './lib/cache-native-decoded.mjs';
import { compareGeometryOracle, decodedWorldPoints, LIMITATIONS } from './lib/cache-native-geometry-oracle.mjs';
import { compareModelOracle } from './lib/cache-native-model-oracle.mjs';
import { nativeDeflatedLength, payload, stored } from './lib/cache-native-storage.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIST = join(ROOT, 'packages/cache/dist/index.js');
const DATA_DIST = join(ROOT, 'packages/data/dist/index.js');
const PARSER_DIST = join(ROOT, 'packages/parser/dist/index.js');
const REQUIRE_FIXTURES = process.env.IFC_LITE_REQUIRE_FIXTURES === '1';

const FIXTURES = [
  // Committed, so the gate never runs empty.
  { path: 'apps/viewer/public/samples/hello-wall.ifc', committed: true },
  { path: 'apps/viewer/public/samples/building-architecture.ifc', committed: true },
  { path: 'apps/viewer/public/samples/infra-bridge.ifc', committed: true },
  // Committed, for mesh fields the samples above leave unset: an authored
  // finish (rev-b), material-layer slices (materialId, geometryClass 3) and an
  // orphan type-map mesh (geometryClass 1).
  { path: 'apps/viewer/public/samples/building-architecture-rev-b.ifc', committed: true },
  { path: 'tests/fixtures/synthetic-retained/f-g-layers.ifc', committed: true },
  { path: 'tests/fixtures/synthetic-retained/f-m11a-appearance.ifc', committed: true },
  // Committed and georeferenced, so CoordinateInfo is exercised on every run:
  // an IFC2X3 slab ~8,000 km out in a rotated IfcSite (RTC on, rotated site
  // frame), and a millimetre wall in a site placed off the origin.
  { path: 'rust/processing/tests/fixtures/issue_8190_slab_12381.ifc', committed: true },
  { path: 'rust/processing/tests/fixtures/issue_8156_wall_43810.ifc', committed: true },
  // Committed, with world corners known by construction: an IfcSite at
  // (1000000, 2000000, 0) turned 90° about Z, holding a tetrahedron with
  // local corners (0,0,0), (10,0,0), (0,1,0), (0,0,3). Local (10,0,0) must
  // read back at (1000000, 2000010, 0), not translation-only (1000010, 2000000, 0).
  {
    path: 'rust/cache/tests/fixtures/rotated_site_90.ifc',
    committed: true,
    worldPoints: [[999999, 2000000, 0], [1000000, 2000000, 0], [1000000, 2000000, 3], [1000000, 2000010, 0]],
  },
  // Catalogued: a real authoring-tool model, with chunks large enough to deflate.
  { path: 'tests/models/ara3d/AC20-FZK-Haus.ifc', committed: false },
  // Catalogued georeferenced models: IfcMapConversion + IfcProjectedCRS.
  { path: 'tests/models/georeferencer/MiniBIM-3.1-DO_01_VORM.ifc', committed: false },
  { path: 'tests/models/ifc5/Georeferencing_georeferenced-bridge-deck.ifc', committed: false },
];

if (![CACHE_DIST, DATA_DIST, PARSER_DIST].every(existsSync)) {
  console.error('@ifc-lite/cache, @ifc-lite/data or @ifc-lite/parser is not built: run `pnpm build` first.');
  process.exit(1);
}
const cache = await import(CACHE_DIST);
// The TS writer's own chunk compressor (`sections/geometry-codec.ts`), which
// the package index does not re-export.
const { deflateRaw: tsDeflateRaw } = await import(join(ROOT, 'packages/cache/dist/sections/geometry-codec.js'));
const data = await import(DATA_DIST);
const parser = await import(PARSER_DIST);

const examples = ['conformance_writer', 'processing_oracle'];
const build = spawnSync('cargo', ['build', '--locked', '-p', 'ifc-lite-cache', ...examples.flatMap((e) => ['--example', e])], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);
const targetDir = process.env.CARGO_TARGET_DIR || join(ROOT, 'target');
const exampleBin = (name) => join(targetDir, 'debug/examples', process.platform === 'win32' ? `${name}.exe` : name);
const writerBin = exampleBin('conformance_writer');
const oracleBin = exampleBin('processing_oracle');

const work = mkdtempSync(join(tmpdir(), 'cache-native-'));
let checked = 0;
try {
  for (const fixture of FIXTURES) {
    const source = join(ROOT, fixture.path);
    if (!existsSync(source)) {
      assert.ok(!fixture.committed, `${fixture.path} is committed and must exist`);
      assert.ok(!REQUIRE_FIXTURES, `${fixture.path} is absent and IFC_LITE_REQUIRE_FIXTURES=1; run \`pnpm fixtures\``);
      console.log(`SKIP ${fixture.path}: absent; run \`pnpm fixtures\``);
      continue;
    }
    await checkFixture(fixture, source);
    checked++;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
assert.ok(checked >= FIXTURES.filter((f) => f.committed).length, 'the committed fixtures always run');
console.log(`native cache conformance: ${checked} fixture(s) passed`);
console.log('Not claimed (absent from every native cache; no check above asserts browser equivalence for them):');
for (const limitation of LIMITATIONS) console.log(`  - ${limitation}`);

function writeNative(source, threads) {
  const out = join(work, `native-${threads ?? 'default'}.ifclite`);
  const env = { ...process.env };
  if (threads) env.RAYON_NUM_THREADS = String(threads);
  else delete env.RAYON_NUM_THREADS;
  const run = spawnSync(writerBin, [source, out], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, `conformance_writer failed: ${run.stderr}`);
  return { bytes: readFileSync(out), stats: JSON.parse(run.stdout) };
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function checkFixture(fixture, sourcePath) {
  const label = fixture.path;
  const sourceBytes = readFileSync(sourcePath);
  const sourceBuffer = toArrayBuffer(sourceBytes);

  // 1. Byte self-reproducibility across thread counts.
  const native = writeNative(sourcePath);
  const single = writeNative(sourcePath, 1);
  assert.ok(native.bytes.equals(single.bytes), `${label}: RAYON_NUM_THREADS=1 and default differ`);
  assert.ok(native.stats.meshCount > 0, `${label}: produced meshes`);

  // 4. Acceptance, with source-hash validation.
  const nativeBuffer = toArrayBuffer(native.bytes);
  const reader = new cache.BinaryCacheReader();
  const header = reader.readHeader(nativeBuffer);
  assert.equal(header.version, cache.FORMAT_VERSION);
  assert.equal(header.hasSourceHash, true);
  assert.equal(header.sourceHash, cache.xxhash64(sourceBuffer), `${label}: header hash is xxhash64(source)`);
  assert.equal(reader.validate(nativeBuffer, sourceBuffer), true);
  const decoded = await reader.read(nativeBuffer, { sourceBuffer });
  const changed = new Uint8Array(sourceBytes);
  changed[changed.length - 2] ^= 0xff;
  await assert.rejects(reader.read(nativeBuffer, { sourceBuffer: toArrayBuffer(Buffer.from(changed)) }), /source file has changed/);
  await checkRefusals(label, native.bytes);

  // 6. The geometry against the canonical pipeline output. It also yields the
  // decoded meshes in the pipeline's emit order, which the TS writer is given
  // below: grouping is not idempotent on chunk-ordered input (a cell closed
  // by the byte cap can be listed before cells first seen earlier), so only
  // the emit order lets the two writers' chunk order be compared at all.
  const pipeline = compareGeometryOracle(label, { dump: processingDump(sourcePath), decoded, header });
  if (fixture.worldPoints) {
    assert.deepEqual(decodedWorldPoints(decoded), fixture.worldPoints, `${label}: world corners as the reader places them`);
  }

  // 2 + 3. The TS writer over the same model, meshes in emit order.
  const entityIndex = decoded.entityIndex;
  assert.ok(entityIndex, `${label}: EntityIndex section read back`);
  const dataStore = {
    ...decoded.dataStore,
    entityIndex: { byId: borrowedColumns(entityIndex) },
  };
  const geometryInEmitOrder = { ...decoded.geometry, meshes: pipeline.emitOrder };
  const tsBytes = Buffer.from(await new cache.BinaryCacheWriter().write(dataStore, geometryInEmitOrder, sourceBuffer));
  const nativeSections = sections(native.bytes);
  const tsSections = sections(tsBytes);
  assert.ok(native.bytes.subarray(0, 64).equals(tsBytes.subarray(0, 64)), `${label}: 64-byte header`);
  assert.deepEqual(tsSections.map((s) => s.type), nativeSections.map((s) => s.type), `${label}: section order`);
  for (let i = 0; i < nativeSections.length; i++) {
    const n = nativeSections[i];
    const t = tsSections[i];
    assert.equal(t.offset, n.offset, `${label}: section ${n.type} offset`);
    if (n.type === cache.SectionType.Geometry) continue;
    assert.ok(n.bytes.equals(t.bytes), `${label}: section ${n.type} bytes (native ${n.size}, TS ${t.size})`);
  }
  const geometry = nativeSections.find((s) => s.type === cache.SectionType.Geometry);
  const tsGeometry = tsSections.find((s) => s.type === cache.SectionType.Geometry);
  assert.ok(geometry && tsGeometry, `${label}: both caches carry geometry`);
  assert.ok(!nativeSections.some((s) => s.type === cache.SectionType.InstancedShards), 'native writes no shards');
  const storage = await compareGeometry(label, native.bytes, geometry, tsBytes, tsGeometry);

  // Decoded values against the TS libraries' own tables.
  compareDecodedModel(label, { decoded, sourceBytes, data });
  console.log(`ok ${label}: ${native.stats.entityRows} rows, ${native.stats.meshCount} meshes, ` +
    `${storage.chunks} chunks (${storage.compressed} deflated natively, ${storage.flagDiffers} with a different storage flag)`);

  // 5. The data model against an independent TS parse of the same IFC.
  const model = await compareModelOracle(label, { sourceBytes, decoded, parser, cache });
  console.log(`   model oracle: ${model}`);
  console.log(`   geometry oracle: ${pipeline.meshes} meshes equal to the pipeline's (${pipeline.dropped} dropped by validateMeshes)`);
  for (const line of pipeline.limitations) console.log(`   limitation: ${line}`);
}

function processingDump(source) {
  const out = join(work, 'processing.json');
  const run = spawnSync(oracleBin, [source, out], { encoding: 'utf8' });
  assert.equal(run.status, 0, `processing_oracle failed: ${run.stderr}`);
  return JSON.parse(readFileSync(out, 'utf8'));
}

/** `CacheEntityIndex.byId` over decoded columns: the borrowed-columns path. */
function borrowedColumns(columns) {
  const byId = {
    *[Symbol.iterator]() {
      for (let i = 0; i < columns.ids.length; i++) {
        yield [columns.ids[i], {
          expressId: columns.ids[i],
          type: columns.typeNames[columns.typeIndices[i]],
          byteOffset: columns.byteOffsets[i],
          byteLength: columns.byteLengths[i],
        }];
      }
    },
    getColumns: () => ({
      expressIds: columns.ids,
      byteOffsets: columns.byteOffsets,
      byteLengths: columns.byteLengths,
      typeIndices: columns.typeIndices,
      typeStrings: columns.typeNames,
    }),
  };
  return byId;
}

function sections(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(29, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = 64 + i * 16;
    const type = view.getUint16(at, true);
    const offset = view.getUint32(at + 4, true);
    const size = view.getUint32(at + 8, true);
    out.push({ type, offset, size, bytes: bytes.subarray(offset, offset + size) });
  }
  return out;
}

async function compareGeometry(label, nativeBytes, native, tsBytes, ts) {
  const head = (bytes, section) => {
    const reader = new cache.BufferReader(toArrayBuffer(bytes));
    reader.position = section.offset;
    return cache.readGeometryHeadV13(reader, cache.FORMAT_VERSION);
  };
  const n = head(nativeBytes, native);
  const t = head(tsBytes, ts);
  assert.equal(t.headLength, n.headLength, `${label}: headLength`);
  // Everything before the directory: counts, CoordinateInfo, source pool, chunkCount.
  const directoryAt = 4 + n.headLength - n.chunks.length * 44;
  assert.ok(native.bytes.subarray(0, directoryAt).equals(ts.bytes.subarray(0, directoryAt)), `${label}: geometry head`);
  assert.equal(t.chunks.length, n.chunks.length, `${label}: chunk count`);
  let compressed = 0;
  let flagDiffers = 0;
  for (let i = 0; i < n.chunks.length; i++) {
    const at = directoryAt + i * 44;
    const where = `${label}: chunk ${i}`;
    // AABB (f32 bits), uncompressedLength, meshCount: equal as stored.
    assert.ok(native.bytes.subarray(at, at + 24).equals(ts.bytes.subarray(at, at + 24)), `${where} AABB`);
    assert.equal(t.chunks[i].uncompressedLength, n.chunks[i].uncompressedLength, `${where} uncompressedLength`);
    assert.equal(t.chunks[i].meshCount, n.chunks[i].meshCount, `${where} meshCount`);
    const payloadN = await payload(cache, native.bytes, n.chunks[i], where + ' (native)', nativeDeflatedLength(writerBin, work));
    const payloadT = await payload(cache, ts.bytes, t.chunks[i], where + ' (TS)', async (raw) => (await tsDeflateRaw(raw)).length);
    assert.ok(payloadN.equals(payloadT), `${where}: uncompressed payload differs from byte ${firstDifference(payloadN, payloadT)}`);
    if (n.chunks[i].flags & cache.GeometryChunkFlags.DeflateRaw) compressed++;
    if (n.chunks[i].flags !== t.chunks[i].flags) flagDiffers++;
    // A standalone copy: `Buffer#slice` is a view, which the decoder would read past.
    const meshesN = await cache.decodeGeometryChunk(new Uint8Array(stored(native.bytes, n.chunks[i])), n.chunks[i], cache.FORMAT_VERSION);
    const meshesT = await cache.decodeGeometryChunk(new Uint8Array(stored(ts.bytes, t.chunks[i])), t.chunks[i], cache.FORMAT_VERSION);
    assert.deepEqual(meshRecords(meshesN), meshRecords(meshesT), `${where}: decoded mesh records`);
  }
  return { chunks: n.chunks.length, compressed, flagDiffers };
}


/** Every mesh field as exact bits, so a NaN or -0 cannot compare loosely. */
function meshRecords(meshes) {
  const bits = (array) => (array ? Array.from(new Uint32Array(Float32Array.from(array).buffer)) : undefined);
  const bits64 = (array) => (array ? Array.from(array, (v) => Buffer.from(new Float64Array([v]).buffer).toString('hex')) : undefined);
  return meshes.map((m) => ({
    expressId: m.expressId,
    ifcType: m.ifcType,
    geometryClass: m.geometryClass,
    geometryItemId: m.geometryItemId,
    materialId: m.materialId,
    color: bits(m.color),
    origin: bits64(m.origin),
    positions: bits(m.positions),
    normals: bits(m.normals),
    indices: Array.from(m.indices),
    material: m.material,
    shadingColor: bits(m.shadingColor),
    localBounds: m.localBounds && [bits(m.localBounds.min), bits(m.localBounds.max)],
    localToWorld: bits64(m.localToWorld),
    appearanceSource: m.appearanceSource,
  }));
}

/** Truncated, bad magic, a newer version and a corrupt chunk length all refuse. */
async function checkRefusals(label, bytes) {
  const reader = new cache.BinaryCacheReader();
  const variant = (mutate) => {
    const copy = Buffer.from(bytes);
    return toArrayBuffer(mutate(copy) ?? copy);
  };
  await assert.rejects(reader.read(variant((b) => b.subarray(0, Math.floor(b.length / 2)))), Error, `${label}: truncated`);
  await assert.rejects(reader.read(variant((b) => { b.writeUInt32LE(0x46494c43, 0); })), /Invalid magic/, `${label}: bad magic`);
  await assert.rejects(reader.read(variant((b) => { b.writeUInt16LE(cache.FORMAT_VERSION + 1, 4); })), /Unsupported format version/, `${label}: version`);
  // Chunk 0's byteLength sits 28 bytes into its 44-byte directory entry; the
  // directory ends where the head does, so count back from there.
  const geometry = sections(bytes).find((s) => s.type === cache.SectionType.Geometry);
  const headReader = new cache.BufferReader(toArrayBuffer(bytes));
  headReader.position = geometry.offset;
  const head = cache.readGeometryHeadV13(headReader, cache.FORMAT_VERSION);
  const firstEntry = geometry.offset + 4 + head.headLength - head.chunks.length * 44;
  await assert.rejects(
    reader.read(variant((b) => { b.writeUInt32LE(b.readUInt32LE(firstEntry + 28) + 1, firstEntry + 28); })),
    /Invalid cache/,
    `${label}: corrupt chunk length`,
  );
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `${i} (native ${a[i]}, TS ${b[i]})`;
  return `${n} (lengths ${a.length} vs ${b.length})`;
}
