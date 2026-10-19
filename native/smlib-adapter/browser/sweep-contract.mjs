// SPDX-License-Identifier: MPL-2.0
// Actual SDK witness shared by module-worker browser and independent WASM modules.
import { regionWitnesses, rationalDiskRecipe, rationalDiskWitnesses } from './region-recipes.mjs';
import { meshWitness } from './mesh-witness.mjs';
import { uploadSweep } from './sweep.mjs';
import { assert, request, response, u32, f64 } from './contract.mjs';
export function rectangleRecipe(divisions = 1) {
  const count = 4 * divisions, bytes = new Uint8Array(56 + count * 104), view = new DataView(bytes.buffer);
  [1, 1, count, 0].forEach((value, i) => view.setUint32(i * 4, value, true));
  [0, 0, 1, 3].forEach((value, i) => view.setFloat64(16 + i * 8, value, true));
  view.setUint32(52, count, true);
  const points = [[0, 0], [2, 0], [2, 4], [0, 4]];
  for (let edge = 0; edge < 4; edge++) for (let part = 0; part < divisions; part++) {
    const offset = 56 + (edge * divisions + part) * 104;
    view.setUint32(offset, 1, true);
    for (let axis = 0; axis < 2; axis++) {
      const a = points[edge][axis], delta = points[(edge + 1) % 4][axis] - a;
      view.setFloat64(offset + 8 + axis * 8, a + delta * part / divisions, true);
      view.setFloat64(offset + 32 + axis * 8, a + delta * (part + 1) / divisions, true);
    }
  }
  return bytes;
}
export function circleRecipe() {
  const bytes = new Uint8Array(160), view = new DataView(bytes.buffer);
  [1, 1, 1, 0].forEach((value, i) => view.setUint32(i * 4, value, true));
  [0, 0, 1, 3].forEach((value, i) => view.setFloat64(16 + i * 8, value, true));
  view.setUint32(52, 1, true); view.setUint32(56, 2, true);
  [0, 0, 0, 0, 0, 1, 1, 0, 0, 2, 0, Math.PI * 2]
    .forEach((value, i) => view.setFloat64(64 + i * 8, value, true));
  return bytes;
}
export function diskRecipe(curved = false) { return rationalDiskRecipe(curved); }
export async function runSweepContract(transport, incarnation) {
  const batch = (frames) => transport.batch(frames, incarnation);
  const call = async (op, ...fields) => response((await batch([request(op, ...fields)]))[0]);
  const session = await call(1), sessionId = new DataView(session.buffer).getBigUint64(0, true);
  const results = [];
  let primaryFailed = false;
  try {
  const fixtures = [
    { name: 'subdivided-rectangle', recipe: rectangleRecipe(32), loops: 1, segments: 128, expected: 24, format: 1 },
    { name: 'circle', recipe: circleRecipe(), loops: 1, segments: 1, expected: 12 * Math.PI, format: 1 },
    ...rationalDiskWitnesses(),
    ...regionWitnesses(),
  ];
  for (const fixture of fixtures) {
    const { recipe, loops, segments, expected, format, name } = fixture;
    const handle = await uploadSweep(transport, sessionId, recipe, { loops, segments, format }, incarnation);
    const solid = new Uint8Array(handle.bytes);
    const manifold = new DataView((await call(7, session, solid)).buffer).getUint32(0, true);
    assert(manifold === 1, `${name}: SDK manifold solid`);
    const volume = new DataView((await call(6, session, solid, f64(1e-8))).buffer).getFloat64(0, true);
    assert(Math.abs(volume - expected) < 1e-5, `${name}: SDK volume vs derived analytic volume`);
    const matrix = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 10, 20, 30, 1];
    const moved = await call(17, session, solid, ...matrix.map(f64));
    const movedVolume = new DataView((await call(6, session, moved, f64(1e-8))).buffer).getFloat64(0, true);
    assert(Math.abs(movedVolume - expected) < 1e-5, 'copied rigid transform volume');
    const duplicate = await call(5, session, solid, solid, u32(1));
    const unchanged = new DataView((await call(6, session, solid, f64(1e-8))).buffer).getFloat64(0, true);
    assert(Math.abs(unchanged - expected) < 1e-5, 'authored operand immutable');
    const region = fixture.area === undefined ? undefined : fixture;
    const shape = fixture.pipe ? fixture : region;
    const originalMesh = await meshWitness(call, session, solid, expected, shape);
    const movedMesh = await meshWitness(call, session, moved, expected, shape, true);
    for (const object of [moved, duplicate, solid]) await call(8, session, object);
    results.push({ name, expected, evidence: 'derived numerical recipe; not source IFC qualification',
      sdkVolume: volume, copiedSdkVolume: movedVolume, originalMesh, movedMesh,
      ...(region && { expectedProfileArea: region.area, expectedSectionLength: region.perimeter,
        expectedSurfaceArea: region.surface, expectedSectionLoops: region.loops }),
      ...(fixture.pipe && { expectedPipeBounds: fixture.pipe.bounds, expectedSurfaceArea: fixture.pipe.surface }),
      analyticSurfaceIdentity: 'not exposed by protocol', analyticSection: 'not exposed by protocol' });
  }
  // Real worker cleanup contract: invalid offset discards, incomplete commit consumes.
  let token = await call(13, session, u32(1), u32(472), u32(1), u32(4));
  response((await batch([request(14, session, token, u32(0xffffffff), u32(1), new Uint8Array([1]))]))[0], 1);
  response((await batch([request(15, session, token)]))[0], 3);
  token = await call(13, session, u32(1), u32(472), u32(1), u32(4));
  response((await batch([request(15, session, token)]))[0], 1);
  response((await batch([request(13, session, u32(1), u32(0xffffffff), u32(1), u32(0xffffffff))]))[0], 1);
  response((await batch([request(13, session, u32(1), u32(480), u32(129), u32(4))]))[0], 1);
  return results;
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    // Session ownership covers every solid/mesh if any assertion fails mid-test.
    if (transport.incarnation === incarnation) {
      try { await call(2, session); }
      catch (error) {
        if (transport.retire) transport.retire(incarnation);
        else if (incarnation !== undefined && transport.incarnation === incarnation) transport.dispose();
        if (!primaryFailed) throw error;
        console.error("SDK witness session cleanup failed after primary failure", error);
      }
    }
  }
}
