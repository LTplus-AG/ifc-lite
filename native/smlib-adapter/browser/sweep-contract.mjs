// SPDX-License-Identifier: MPL-2.0
// Actual SDK witnesses for one transport incarnation: the same ordered-region
// and rational-disk cases the native worker runs before it opens its curved
// gates (rust/geometry-runtime worker_qualification.rs and
// worker_disk_qualification.rs). Derived numerical recipes only; this is not
// source IFC qualification and a protocol peer can never satisfy it.
import { uploadSweep } from './sweep.mjs';
import { assert, request, response, u32, f64 } from './contract.mjs';

const TAU = 2 * Math.PI;
const line = (a, b) => ({ kind: 1, values: [a[0], a[1], 0, b[0], b[1], 0, 0, 0, 0, 0, 0, 0] });
const arc = (radius, sweep) => ({
  kind: Math.abs(sweep) === TAU ? 2 : 3,
  values: [0, 0, 0, 0, 0, 1, 1, 0, 0, radius, 0, sweep],
});
function square(half, inner) {
  const points = [[-half, -half], [half, -half], [half, half], [-half, half]];
  if (inner) points.reverse();
  return points.map((point, i) => line(point, points[(i + 1) % 4]));
}

/** Format 1 recipe: unit direction (0,0,1) or oblique (0.6,0,0.8), depth 3. */
export function regionRecipe(loops, oblique = false) {
  const segments = loops.reduce((n, boundary) => n + boundary.length, 0);
  const bytes = new Uint8Array(48 + 8 * loops.length + 104 * segments);
  const view = new DataView(bytes.buffer);
  [1, loops.length, segments, 0].forEach((value, i) => view.setUint32(i * 4, value, true));
  [oblique ? 0.6 : 0, 0, oblique ? 0.8 : 1, 3].forEach((value, i) => view.setFloat64(16 + i * 8, value, true));
  let offset = 48;
  loops.forEach((boundary, i) => {
    view.setUint32(offset, i === 0 ? 0 : 1, true);
    view.setUint32(offset + 4, boundary.length, true);
    offset += 8;
    for (const curve of boundary) {
      view.setUint32(offset, curve.kind, true);
      curve.values.forEach((value, k) => view.setFloat64(offset + 8 + k * 8, value, true));
      offset += 104;
    }
  });
  return { bytes, loops: loops.length, segments };
}
/** The rectangle family: needs no witness, but shares the same staged upload. */
export function rectangleRecipe() { return regionRecipe([square(0.5, false)]); }

/** Format 2 recipe: 0.25 m solid disk on a straight (5 m) or quarter-circle path. */
export function diskRecipe(curved) {
  const controls = curved ? [4, 0, 0, 1, 4, 4, 0, Math.SQRT1_2, 0, 4, 0, 1] : [0, 0, 0, 2, 0, 0, 5, 3];
  const bytes = new Uint8Array(72 + controls.length * 8 + 2 * 16);
  const view = new DataView(bytes.buffer);
  [2, 1, 1, 0].forEach((value, i) => view.setUint32(i * 4, value, true));
  [0.25, 0].forEach((value, i) => view.setFloat64(16 + i * 8, value, true));
  [4, 0, curved ? 2 : 1, curved ? 3 : 2, 2, 0].forEach((value, i) => view.setUint32(32 + i * 4, value, true));
  [0, 1].forEach((value, i) => view.setFloat64(56 + i * 8, value, true)); // trim interval
  let offset = 72;
  for (const value of controls) { view.setFloat64(offset, value, true); offset += 8; }
  for (const knot of [0, 1]) {
    view.setFloat64(offset, knot, true);
    view.setUint32(offset + 8, curved ? 3 : 2, true);
    offset += 16;
  }
  return { bytes, loops: 1, segments: 1 };
}

const REGION_CASES = [
  { loops: [[arc(2, TAU)]], area: 4 * Math.PI, half: 2 },
  { loops: [[arc(2, -TAU)]], area: 4 * Math.PI, half: 2 },
  { loops: [[arc(2, TAU)], [arc(1, -TAU)]], area: 3 * Math.PI, half: 2 },
  { loops: [square(3, false), square(1, true)], area: 32, half: 3 },
  { loops: [[arc(2, Math.PI), line([-2, 0], [2, 0])]], area: 2 * Math.PI, half: 2, halfDisk: true },
  { loops: [[arc(2, TAU)], [arc(1, -TAU)]], area: 3 * Math.PI, half: 2, oblique: true },
];

export async function runSweepContract(transport, incarnation) {
  const batch = (frames) => transport.batch(frames, incarnation);
  const call = async (op, ...fields) => response((await batch([request(op, ...fields)]))[0]);
  const session = await call(1), sessionId = new DataView(session.buffer).getBigUint64(0, true);
  const scalar = (bytes, float) => float ? new DataView(bytes.buffer).getFloat64(0, true) : new DataView(bytes.buffer).getUint32(0, true);
  async function positions(solid) {
    const mesh = await call(9, session, solid, f64(0.0001), f64(5));
    try {
      const vertices = scalar(await call(10, session, mesh), false);
      const values = [];
      for (let offset = 0; offset < vertices * 3; offset += 480) {
        const count = Math.min(480, vertices * 3 - offset);
        const chunk = await call(11, session, mesh, u32(1), u32(offset), u32(count));
        for (let i = 0; i < count; i++) values.push(new DataView(chunk.buffer).getFloat64(i * 8, true));
      }
      return values;
    } finally { await call(8, session, mesh); }
  }
  function bounds(values) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < values.length; i += 3) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], values[i + axis]); max[axis] = Math.max(max[axis], values[i + axis]);
    }
    return { min, max };
  }
  const near = (actual, expected) => actual.every((value, i) => Math.abs(value - expected[i]) <= 0.002);
  async function witness({ bytes, loops, segments }, format, check) {
    const handle = await uploadSweep(transport, sessionId, bytes, { loops, segments, format }, incarnation);
    const solid = new Uint8Array(handle.bytes);
    try {
      const volume = scalar(await call(6, session, solid, f64(1e-8)), true);
      assert(scalar(await call(7, session, solid), false) === 1, 'SDK manifold solid');
      await check(volume, solid);
      return volume;
    } finally { await call(8, session, solid); }
  }
  let primaryFailed = false;
  try {
    const regions = [];
    for (const { loops, area, half, halfDisk = false, oblique = false } of REGION_CASES) {
      const height = oblique ? 2.4 : 3;
      regions.push(await witness(regionRecipe(loops, oblique), 1, async (volume, solid) => {
        assert(Math.abs(volume - area * height) <= area * height * 1e-5, 'ordered-region volume witness');
        const values = await positions(solid), { min, max } = bounds(values);
        assert(near(min, [-half, halfDisk ? 0 : -half, 0]) && near(max, [half + (oblique ? 1.8 : 0), half, height]),
          'ordered-region cap bounds witness');
        // Circular annular caps cannot include a vertex inside the hole.
        if (loops.length === 2 && loops[0].length === 1) for (let i = 0; i < values.length; i += 3) {
          const r = Math.hypot(values[i] - (oblique ? values[i + 2] * 0.75 : 0), values[i + 1]);
          assert(r >= 0.999 && r <= 2.001, 'annular boundary witness');
        }
      }));
    }
    const disks = [];
    for (const curved of [false, true]) {
      disks.push(await witness(diskRecipe(curved), 2, async (volume, solid) => {
        const expected = Math.PI * 0.25 * 0.25 * (curved ? TAU : 5);
        assert(Math.abs(volume - expected) <= expected * 1e-4, 'rational pipe volume witness');
        if (!curved) {
          const { min, max } = bounds(await positions(solid));
          assert(near(min, [-0.25, -0.25, 0]) && near(max, [0.25, 0.25, 5]), 'rational pipe bounds witness');
        }
      }));
    }
    // Actual ABI cleanup: an invalid chunk discards, a later commit refuses it.
    const token = await call(13, session, u32(1), u32(472), u32(1), u32(4));
    response((await batch([request(14, session, token, u32(0xffffffff), u32(1), new Uint8Array([1]))]))[0], 1);
    response((await batch([request(15, session, token)]))[0], 3);
    return { regions, disks, evidence: 'derived numerical recipes; not source IFC qualification' };
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    // Session ownership covers every solid/mesh if any assertion fails mid-run.
    if (transport.incarnation === incarnation) {
      try { await call(2, session); } catch (error) {
        transport.retire?.(incarnation);
        if (!primaryFailed) throw error;
      }
    }
  }
}
