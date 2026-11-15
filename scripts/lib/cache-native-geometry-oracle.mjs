/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Geometry oracle for `scripts/cache-native-conformance.mjs` (#9584).
 *
 * The round trip through the TS writer proves the two encoders agree; it
 * cannot see a mesh field the native writer dropped or altered before
 * encoding. This compares the meshes the TS reader decodes from the native
 * cache against the canonical `ifc_lite_processing::process` output for the
 * same IFC, dumped by `rust/cache/examples/processing_oracle.rs` (which uses
 * no writer code), after the documented frame conversion done HERE, in JS:
 *
 *   IFC Z-up (x, y, z) -> viewer Y-up (x, z, -y) for positions, normals and
 *   the mesh origin (a swap and a negation, so -0 stays -0); an AABB's new Z
 *   range is [-maxY, -minY]; a row-major 4x4 placement M becomes the matrix
 *   product S·M·Sᵀ (whose zero entries are +0).
 *
 * Every comparison is exact (f32/f64 bits, or `===` for f64 world values,
 * where -0 and +0 are the same coordinate). No tolerance is needed: the
 * conversion only permutes and negates, and the world sums are the same IEEE
 * operations in the same order as `MeshFrame::to_world`.
 *
 * Sink semantics the oracle applies on its own (`ProcessingSink` docs):
 * `on_finishes` belongs to the `on_batch` that follows it, index for index;
 * `on_color_update` corrects the colour of meshes ALREADY emitted for that
 * id. The TS `validateMeshes` rule (SPEC §9.5) drops a mesh whose normals do
 * not pair with its positions or whose counts exceed the caps.
 *
 * What a v28 cache cannot carry is reported, never compared through: see
 * `LIMITATIONS` and the per-fixture `limitation` lines.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Fields the native cache leaves absent, each a documented limitation (crate docs). */
export const LIMITATIONS = [
  'InstancedShards (IFNS) are never written: native process has no GPU-instancing partition',
  'appearance provenance (v19) is mode 0 on every mesh; the source-index pool is empty',
  'selection coverage (v28 EntityIndex trailer) is absent',
  'shadingColor (v25) is never present',
  'CoordinateInfo.wasmRtcFrame, buildingRotation and boundsRecoveryFallbackCount are absent',
  'per-mesh origins are the native pass\'s (zero for most meshes), not the browser path\'s local frames',
  'the frame is the native pass\'s (its RTC offset and IfcSite tier), not the browser pre-pass\'s',
  'a rotated IfcSite-local pass frame is not expressible: world = R·local + rtc needs R',
  'MeshData fields with no v28 record slot (uvs, texture, instancing metadata, globalId, name, layer, material name, properties, presentation)',
];

const MAX_VERTEX_COUNT = 100_000_000;
const MAX_INDEX_COUNT = 300_000_000;

/** A fresh, offset-0 copy, so typed views over it are always aligned. */
const bytes = (hex) => new Uint8Array(Buffer.from(hex, 'hex')).buffer;
const f32 = (hex) => new Float32Array(bytes(hex));
const f64 = (hex) => new Float64Array(bytes(hex));
const u32 = (hex) => new Uint32Array(bytes(hex));
const utf8 = (hex) => Buffer.from(hex, 'hex').toString('utf8');

/** Z-up -> Y-up over a flat xyz buffer, in f32: a swap and a negation, both exact. */
function yUp(buffer) {
  const out = new Float32Array(buffer.length);
  for (let i = 0; i + 2 < buffer.length; i += 3) {
    out[i] = buffer[i];
    out[i + 1] = buffer[i + 2];
    out[i + 2] = -buffer[i + 1];
  }
  return out;
}

/** The Z-up -> Y-up map S, row-major: (x, y, z) -> (x, z, -y). */
const S = [[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]];

/** S·M·Sᵀ for a row-major M, as the matrix product (`frame.rs` documents its conjugation as bit-equal to it). */
function conjugate(m) {
  const at = (r, c) => m[r * 4 + c];
  const sm = (r, c) => { let acc = 0; for (let k = 0; k < 4; k++) acc += S[r][k] * at(k, c); return acc; };
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let k = 0; k < 4; k++) acc += sm(r, k) * S[c][k];
      out[r * 4 + c] = acc;
    }
  }
  return out;
}

/** The pipeline's emitted meshes, in emit order, with finishes and colour corrections applied. */
function emitted(dump) {
  const meshes = [];
  let finishes = null;
  for (const event of dump.events) {
    if (event.event === 'finishes') {
      assert.equal(finishes, null, 'two on_finishes without an on_batch between them');
      finishes = event.finishes;
    } else if (event.event === 'batch') {
      if (finishes) assert.equal(finishes.length, event.meshes.length, 'on_finishes pairs with its batch');
      event.meshes.forEach((mesh, i) => meshes.push({ ...mesh, finish: finishes?.[i] ?? null }));
      finishes = null;
    } else if (event.event === 'colorUpdate') {
      const updates = new Map(event.updates.map(([id, rgba]) => [id, rgba]));
      for (const mesh of meshes) if (updates.has(mesh.expressId)) mesh.color = updates.get(mesh.expressId);
    } else {
      assert.fail(`unknown sink event ${event.event}`);
    }
  }
  assert.equal(finishes, null, 'a trailing on_finishes with no batch');
  assert.equal(meshes.length, dump.retainedMeshes, 'the batches are the retained meshes');
  return meshes;
}

/** A processing mesh as the v28 record the TS reader should decode, in the viewer frame. */
function expectedRecord(mesh) {
  const finite = (hex) => {
    if (hex === null) return undefined;
    const value = f32(hex)[0];
    return Number.isFinite(value) ? value : undefined;
  };
  const metallic = finite(mesh.finish?.metallic ?? null);
  const roughness = finite(mesh.finish?.roughness ?? null);
  const [ox, oy, oz] = f64(mesh.origin);
  const origin = [ox, oz, -oy];
  let localBounds;
  if (mesh.localBounds !== null) {
    const [minX, minY, minZ, maxX, maxY, maxZ] = f32(mesh.localBounds);
    localBounds = { min: Float32Array.of(minX, minZ, -maxY), max: Float32Array.of(maxX, maxZ, -minY) };
  }
  return {
    expressId: mesh.expressId,
    ifcType: utf8(mesh.ifcType) || undefined,
    geometryClass: mesh.geometryClass,
    geometryItemId: mesh.geometryItemId ?? undefined,
    materialId: mesh.materialId ?? undefined,
    color: f32(mesh.color),
    // The reader returns no origin when all three are zero, of either sign.
    origin: origin.some((v) => v !== 0) ? origin : undefined,
    positions: yUp(f32(mesh.positions)),
    normals: yUp(f32(mesh.normals)),
    indices: u32(mesh.indices),
    material: metallic === undefined && roughness === undefined ? undefined
      : { ...(metallic !== undefined ? { metallic } : {}), ...(roughness !== undefined ? { roughness } : {}) },
    shadingColor: undefined,
    localBounds,
    localToWorld: mesh.localToWorld === null ? undefined : conjugate(f64(mesh.localToWorld)),
    appearanceSource: undefined,
  };
}

/** Every field as exact bits, so NaN and -0 cannot compare loosely. */
function canonical(m) {
  const bits32 = (a) => (a ? Buffer.from(Float32Array.from(a).buffer).toString('hex') : '-');
  const bits64 = (a) => (a ? Buffer.from(Float64Array.from(a).buffer).toString('hex') : '-');
  return {
    expressId: m.expressId,
    ifcType: m.ifcType ?? '-',
    geometryClass: m.geometryClass,
    geometryItemId: m.geometryItemId ?? '-',
    materialId: m.materialId ?? '-',
    color: bits32(m.color),
    origin: bits64(m.origin),
    positions: bits32(m.positions),
    normals: bits32(m.normals),
    indices: Buffer.from(Uint32Array.from(m.indices).buffer).toString('hex'),
    material: m.material ? `${bits32([m.material.metallic ?? NaN])}/${bits32([m.material.roughness ?? NaN])}/${Object.keys(m.material).sort()}` : '-',
    shadingColor: bits32(m.shadingColor),
    localBounds: m.localBounds ? bits32([...m.localBounds.min, ...m.localBounds.max]) : '-',
    localToWorld: bits64(m.localToWorld),
    appearanceSource: m.appearanceSource === undefined ? '-' : JSON.stringify(m.appearanceSource),
  };
}

const digest = (fields) => createHash('sha256').update(JSON.stringify(fields)).digest('hex');

/**
 * Per express id, the multiset of decoded records equals the expected one.
 * Returns the decoded meshes in the pipeline's emit order (each matched to
 * the expected record it equals), the order the native writer grouped them in.
 */
function compareMeshes(label, expected, decoded) {
  const got = new Map();
  for (const mesh of decoded) {
    const fields = canonical(mesh);
    const list = got.get(mesh.expressId) ?? [];
    list.push({ mesh, fields, key: digest(fields) });
    got.set(mesh.expressId, list);
  }
  const wantIds = [...new Set(expected.map((m) => m.expressId))].sort((a, b) => a - b);
  assert.deepEqual([...got.keys()].sort((a, b) => a - b), wantIds, `${label}: mesh express ids`);
  const ordered = expected.map((mesh) => {
    const fields = canonical(mesh);
    const key = digest(fields);
    const have = got.get(mesh.expressId);
    const at = have.findIndex((h) => h.key === key);
    if (at < 0) {
      const other = have[0]?.fields ?? {};
      const differs = Object.keys(fields).filter((k) => fields[k] !== other[k]);
      assert.fail(`${label}: #${mesh.expressId} has no cache mesh equal to the pipeline's; nearest differs in ${differs.join(', ')}`);
    }
    return have.splice(at, 1)[0].mesh;
  });
  for (const [id, left] of got) assert.equal(left.length, 0, `${label}: #${id} has ${left.length} cache meshes the pipeline did not emit`);
  return ordered;
}

const vec = (v) => (v === undefined ? undefined : [v.x, v.y, v.z]);
const hexOrUndefined = (hex, read) => (hex === null ? undefined : read(hex));

/** `===` per component: a world coordinate or bound of -0 is the same place as +0. */
function sameValues(actual, expected, message) {
  assert.ok(actual.length === expected.length && actual.every((v, i) => v === expected[i]), `${message}: ${actual} vs ${expected}`);
}

/**
 * World coordinates and CoordinateInfo. `raw` are the pipeline's meshes as
 * emitted (Z-up), `expected` the same meshes converted (which compareMeshes
 * already proved bit-equal to the decoded ones). Returns the visible
 * limitation lines for this fixture.
 */
function compareFrame(label, dump, raw, expected, decoded, header) {
  const info = decoded.geometry.coordinateInfo;
  const rtc = Array.from(f64(dump.frame.rtcOffset));
  const world = f64(dump.frame.worldMatrix); // column-major, `MeshFrame::world_matrix`
  const rotated = [0, 1, 2].some((c) => [0, 1, 2].some((r) => world[c * 4 + r] !== (c === r ? 1 : 0)));
  const limitations = [];

  assert.equal(info.hasLargeCoordinates, dump.frame.needsShift, `${label}: hasLargeCoordinates is the pass frame's needs-shift`);
  assert.deepEqual(vec(info.wasmRtcOffset), dump.frame.needsShift ? rtc : undefined, `${label}: wasmRtcOffset is the pass frame's RTC offset (Z-up)`);
  sameValues(vec(info.originShift), [0, 0, 0], `${label}: originShift`);

  // lengthUnitScale and siteOrigin against the producer the browser reads.
  const meta = dump.streamMeta;
  const unit = dump.lengthUnitScale === null ? undefined : f64(dump.lengthUnitScale)[0];
  assert.equal(info.lengthUnitScale, unit, `${label}: lengthUnitScale is the pass's`);
  if (!meta.lengthUnitRefused) assert.equal(info.lengthUnitScale, f64(meta.lengthUnitScale)[0], `${label}: lengthUnitScale is the pre-pass's`);
  assert.deepEqual(vec(info.siteOrigin), hexOrUndefined(meta.siteOrigin, (h) => Array.from(f64(h))), `${label}: siteOrigin is resolve_site_origin's`);

  // World: the format's reading, yUp⁻¹(origin + position) + wasmRtcOffset,
  // against `MeshFrame::to_world` of the raw position (same operations, same
  // order as `frame_point_to_world`).
  const offset = vec(info.wasmRtcOffset) ?? [0, 0, 0];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let unrotated = 0;
  expected.forEach((mesh, at) => {
    const o = mesh.origin ?? [0, 0, 0];
    const p = mesh.positions;
    const z = f32(raw[at].positions);
    const zo = f64(raw[at].origin);
    for (let i = 0; i < p.length; i += 3) {
      const yup = [o[0] + p[i], o[1] + p[i + 1], o[2] + p[i + 2]];
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], yup[a]); max[a] = Math.max(max[a], yup[a]); }
      const fromCache = [yup[0] + offset[0], -yup[2] + offset[1], yup[1] + offset[2]];
      // The pass-frame point: the raw mesh origin plus the raw position (f64).
      const local = [zo[0] + z[i], zo[1] + z[i + 1], zo[2] + z[i + 2]];
      const where = `${label}: #${mesh.expressId} vertex ${i / 3}`;
      if (!dump.frame.needsShift) {
        sameValues(fromCache, local, `${where} world coordinate`);
      } else if (!rotated) {
        sameValues(fromCache, local.map((v, a) => v + rtc[a]), `${where} world coordinate`);
      } else {
        // Stated limitation: the cache keeps the pass-frame position and the
        // translation, not the rotation. Check exactly that, and that the
        // pipeline's world point really is the rotated one.
        sameValues(fromCache, local.map((v, a) => v + rtc[a]), `${where} cache world is the un-rotated site frame`);
        const truth = [0, 1, 2].map((r) => world[r] * local[0] + world[4 + r] * local[1] + world[8 + r] * local[2] + rtc[r]);
        if (truth.some((v, a) => v !== fromCache[a])) unrotated++;
      }
    }
  });
  if (rotated && expected.length > 0) {
    // The difference is real, not a tolerance artefact: some vertex lands elsewhere.
    assert.ok(unrotated > 0, `${label}: a rotated frame moves at least one vertex`);
    limitations.push(`the pass meshed in a rotated IfcSite frame; ${unrotated} cache world vertices omit that rotation`);
  }
  if (expected.length > 0) {
    sameValues([...vec(info.originalBounds.min), ...vec(info.originalBounds.max)], [...min, ...max], `${label}: originalBounds`);
    sameValues([...vec(info.shiftedBounds.min), ...vec(info.shiftedBounds.max)], [...min, ...max], `${label}: shiftedBounds`);
  }
  assert.equal(header.totalVertices, expected.reduce((n, m) => n + m.positions.length / 3, 0), `${label}: header totalVertices`);
  assert.equal(header.totalTriangles, expected.reduce((n, m) => n + m.indices.length / 3, 0), `${label}: header totalTriangles`);

  // Producer provenance the native pass does not publish: absent, and said so.
  assert.equal(info.wasmRtcFrame, undefined, `${label}: wasmRtcFrame absent`);
  assert.equal(info.buildingRotation, undefined, `${label}: buildingRotation absent`);
  assert.equal(info.boundsRecoveryFallbackCount, undefined, `${label}: boundsRecoveryFallbackCount absent`);
  if (meta.buildingRotation !== null) limitations.push(`buildingRotation absent; the browser pre-pass resolves ${f64(meta.buildingRotation)[0]} rad`);
  const browserRtc = Array.from(f64(meta.rtcOffset));
  if (meta.needsShift !== dump.frame.needsShift || browserRtc.some((v, i) => v !== rtc[i])) {
    limitations.push(`pass frame RTC [${rtc}] differs from the browser pre-pass frame [${browserRtc}]`);
  }
  return limitations;
}

/**
 * Compare the decoded native cache with the canonical pipeline output for the
 * same IFC. `dump` is the parsed `processing_oracle` JSON; `header` the TS
 * `readHeader` of the native cache.
 */
export function compareGeometryOracle(label, { dump, decoded, header }) {
  assert.equal(dump.instances, 0, `${label}: the pass emits no instance records (none could be stored)`);
  const meshes = emitted(dump);
  const unencoded = {};
  for (const mesh of meshes) {
    // `instance` is in-memory instancing metadata on a mesh that is still
    // flat and baked; with no instance records, every occurrence is a mesh.
    for (const [field, present] of Object.entries(mesh.unencoded)) if (present) unencoded[field] = (unencoded[field] ?? 0) + 1;
  }
  const valid = meshes.filter((m) => m.positions.length / 24 <= MAX_VERTEX_COUNT && m.indices.length / 8 <= MAX_INDEX_COUNT
    && m.normals.length === m.positions.length);
  const expected = valid.map(expectedRecord);
  assert.equal(decoded.geometry.meshes.length, expected.length, `${label}: mesh count after validateMeshes`);
  const emitOrder = compareMeshes(label, expected, decoded.geometry.meshes);
  const limitations = compareFrame(label, dump, valid, expected, decoded, header);
  for (const [field, count] of Object.entries(unencoded)) limitations.push(`${count} meshes carry ${field}, which a v28 record has no slot for`);
  return { meshes: expected.length, dropped: meshes.length - valid.length, limitations, emitOrder };
}
