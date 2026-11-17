/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// K-layer peel witness scene and its independent analytic reference (#8564).
// Pure ES module: the browser witness and the GPU-free node:test both import it.
//
// Conditioning: glass depth is affine in pixel units u (z = z0 + DEPTH_STEP * u):
// A: u = X, B: u = 2Y + 0.75, C: u = c - X (c = 0.5 mod 1); every constant depth
// (splats, opaque, D/E) is 0.25 mod 1 and every rectangle edge is 0.25 mod 0.5.
// Then each crossing line keeps |du| >= 0.125 at every pixel center and every
// standard 4x sample, so f32 rasterization cannot reorder what this module sorts.
// Declared exact ties (splat S4 at glass D/E, D coincident with E) use dyadic
// depths that the GPU represents and computes exactly in both projections.

export const DEPTH_STEP = 2 ** -12;
export const NEAR = 0.5, FAR = 8.5;
export const MIN_MARGIN = DEPTH_STEP / 16;
/** WebGPU standard sample positions; the witness probe re-verifies them on the GPU. */
export const SAMPLE_POSITIONS = {
  1: [[0.5, 0.5]],
  4: [[0.375, 0.125], [0.875, 0.375], [0.125, 0.625], [0.625, 0.875]],
};
const SH_DC = 0.28209479177387814;

/** Same formulas as MathUtils.orthographicReverseZ(-1,1,-1,1,NEAR,FAR) / perspectiveReverseZ(PI/3,1,NEAR). */
export function cameraMatrix(projection) {
  const m = new Float32Array(16);
  if (projection === 'orthographic') {
    const lr = 1 / (-1 - 1), bt = 1 / (-1 - 1), nf = 1 / (FAR - NEAR);
    m[0] = -2 * lr; m[5] = -2 * bt; m[10] = nf; m[12] = 0 * lr; m[13] = 0 * bt; m[14] = FAR * nf; m[15] = 1;
  } else {
    const f = 1 / Math.tan(Math.PI / 6);
    m[0] = f; m[5] = f; m[11] = -1; m[14] = NEAR;
  }
  return m;
}

const snapConst = value => Math.round(value - 0.25) + 0.25;
const snapEdge = value => Math.round((value - 0.25) * 2) / 2 + 0.25;
const projectZ = (m, [x, y, z]) => (m[2] * x + m[6] * y + m[10] * z + m[14]) / (m[3] * x + m[7] * y + m[11] * z + m[15]);

function screenPosition(m, [x, y, z], size) {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [(cx / w * 0.5 + 0.5) * size, (0.5 - cy / w * 0.5) * size];
}

// Conservative screen box of the upstream quad (support radius 3, kernel 0.3 px).
function splatBounds(m, splat, size) {
  const [qw, qx, qy, qz] = splat.rotation;
  const axes = [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy)],
    [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)],
    [2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy)],
  ];
  const center = screenPosition(m, splat.position, size);
  const deltas = axes.map((axis, i) => screenPosition(m, splat.position.map((p, j) => p + axis[j] * splat.scale[i]), size)
    .map((value, j) => value - center[j]));
  const c00 = deltas.reduce((sum, d) => sum + d[0] * d[0], 0.09), c11 = deltas.reduce((sum, d) => sum + d[1] * d[1], 0.09);
  const c01 = deltas.reduce((sum, d) => sum + d[0] * d[1], 0);
  const extent = 6 * Math.sqrt((c00 + c11) / 2 + Math.hypot((c00 - c11) / 2, c01)) + 2;
  return [center[0] - extent, center[1] - extent, center[0] + extent, center[1] + extent];
}

/**
 * Builds glass, opaque and splat descriptions for one projection and square size.
 * panes 'single' (#8564 option B) keeps only the tilted pane A, which every splat
 * depth crosses: at most one transparent layer per sample, order varying per sample.
 */
export function buildScene(size, projection, { panes = 'all' } = {}) {
  if (!Number.isInteger(size / 2)) throw new Error('Peel scene size must be even');
  const R = size / 2, matrix = cameraMatrix(projection);
  const tieDepth = projection === 'orthographic' ? 0.5625 : 0.25; // d = 4 / d = 2, exact in f32
  const tieU = 0.25, z0 = tieDepth - DEPTH_STEP * tieU;
  const full = [-2 * R, -2 * R, 2 * R, 2 * R];
  const glass = [
    { name: 'A', u: [0, 1, 0], rect: full, color: [0, 0.85, 0.25, 0.5] },
    { name: 'B', u: [0.75, 0, 2], rect: full, color: [0, 0.35, 0.95, 0.5] },
    { name: 'C', u: [Math.round(0.15 * R) + 0.5, -1, 0], rect: [snapEdge(-0.35 * R), -2 * R, 2 * R, 2 * R], color: [0, 0.95, 0.85, 0.5] },
    { name: 'D', u: [tieU, 0, 0], rect: [snapEdge(-0.6 * R), snapEdge(-0.05 * R), snapEdge(0.3 * R), snapEdge(0.65 * R)], color: [0, 0.55, 0.45, 0.5] },
    { name: 'E', u: [tieU, 0, 0], rect: [snapEdge(0.05 * R), snapEdge(0.25 * R), snapEdge(0.75 * R), snapEdge(0.9 * R)], color: [0, 0.15, 0.6, 0.5] },
  ];
  const opaque = { u: snapConst(-0.3 * R) - 1, rect: [snapEdge(-0.95 * R), snapEdge(-0.9 * R), snapEdge(-0.15 * R), snapEdge(-0.2 * R)], color: [0, 0.3, 0.3, 1] };
  const f = 1 / Math.tan(Math.PI / 6);
  // u values stay distinct for every even size (asserted below), except the declared S4 tie.
  const splats = [
    ['red', -0.45, -0.5, snapConst(-0.2 * R), 0.3], ['blue', 0.05, 0, snapConst(0.06 * R) + 1, 1.1],
    ['red', 0.4, -0.35, snapConst(0.25 * R), -0.6], ['blue', 0.55, -0.15, snapConst(0.45 * R), 0.9],
    ['red', -0.3, 0.3, tieU, -1.2], ['blue', -0.05, 0.5, snapConst(-0.1 * R), 0.5],
  ].map(([color, fx, fy, u, theta], index) => {
    const depth = z0 + DEPTH_STEP * u, X = fx * R, Y = fy * R, sigma = 0.16 * R;
    const distance = projection === 'orthographic' ? FAR - (FAR - NEAR) * depth : NEAR / depth;
    const toWorld = value => projection === 'orthographic' ? value / R : value / R * distance / f;
    const position = [toWorld(X), toWorld(-Y), -distance].map(Math.fround);
    const scale = [1, 0.65, 0.45].map(k => Math.fround(toWorld(sigma) * k));
    const rotation = [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)].map(Math.fround);
    const splat = { index, color, u, position, scale, rotation, depth: projectZ(matrix, position) };
    return { ...splat, bounds: splatBounds(matrix, splat, size) };
  });
  const scene = { size, projection, R, z0, matrix, tieDepth, glass, opaque, splats };
  if (splats[4].depth !== tieDepth || glassDepth(scene, 3, 0, 0) !== tieDepth) throw new Error('Declared tie is not exact');
  if (panes === 'single') scene.glass = [glass[0]];
  scene.panes = panes;
  const constants = [opaque.u, ...splats.map(s => s.u)];
  if (new Set(constants).size !== constants.length || constants.some(u => (u % 1 + 1) % 1 !== 0.25)) {
    throw new Error(`Peel scene constants collide or leave the 0.25 class: ${constants}`);
  }
  return scene;
}

export const glassDepth = (scene, index, X, Y) => {
  const [u0, gx, gy] = scene.glass[index].u;
  return scene.z0 + DEPTH_STEP * (u0 + gx * X + gy * Y);
};
const inside = ([x0, y0, x1, y1], X, Y) => X > x0 && X < x1 && Y > y0 && Y < y1;
const edgeClearance = ([x0, y0, x1, y1], X, Y) => Math.min(...[X - x0, x1 - X, Y - y0, y1 - Y].map(Math.abs));

/** Upstream-style SplatSource columns for normalizeGaussianAttributes (PLY encodings). */
export function splatColumns(splats) {
  const keys = ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
  const columns = Object.fromEntries(keys.map(key => [key, new Float32Array(splats.length)]));
  splats.forEach((splat, row) => {
    const rgb = splat.color === 'red' ? [1, 0, 0] : [0, 0, 1];
    const values = [...splat.position, ...splat.scale.map(Math.log), ...splat.rotation, Math.log(3), ...rgb.map(c => (c - 0.5) / SH_DC)];
    keys.forEach((key, i) => { columns[key][row] = values[i]; });
  });
  return { count: splats.length, shDegree: 0, columns };
}

/**
 * Independent per-sample reference for pixel (x, y), sample offset (ox, oy):
 * every element strictly nearer than opaque, far-to-near; ties put splats
 * behind glass, then submission order. Also returns the expected peel layers.
 */
export function sampleReference(scene, x, y, [ox, oy]) {
  const X = x + ox - scene.R, Y = y + oy - scene.R;
  const opaqueDepth = inside(scene.opaque.rect, X, Y) ? scene.z0 + DEPTH_STEP * scene.opaque.u : 0;
  const elements = [];
  scene.glass.forEach((g, index) => {
    if (inside(g.rect, X, Y)) elements.push({ kind: 'glass', index, z: glassDepth(scene, index, X, Y) });
  });
  for (const splat of scene.splats) {
    const [bx0, by0, bx1, by1] = splat.bounds;
    if (x + 1 > bx0 && x < bx1 && y + 1 > by0 && y < by1) elements.push({ kind: 'splat', index: splat.index, z: splat.depth });
  }
  const order = elements.filter(e => e.z > opaqueDepth)
    .sort((a, b) => a.z - b.z || (a.kind === b.kind ? 0 : a.kind === 'splat' ? -1 : 1) || a.index - b.index);
  const layers = [...new Set(order.filter(e => e.kind === 'glass').map(e => e.z))];
  const clearance = Math.min(edgeClearance(scene.opaque.rect, X, Y), ...scene.glass.map(g => edgeClearance(g.rect, X, Y)));
  return { order, layers, opaqueDepth, elements, clearance };
}

/** Margin audit over all pixels/samples: rectangle edges and non-declared depth ties. */
export function auditScene(scene, samples) {
  const declaredTie = (a, b) => a.z === b.z && [a, b].every(e => (e.kind === 'glass' && e.index >= 3) || (e.kind === 'splat' && e.index === 4));
  let minMargin = Infinity, minClearance = Infinity, exactTies = 0, maxLayers = 0;
  for (let y = 0; y < scene.size; y++) for (let x = 0; x < scene.size; x++) for (const offset of SAMPLE_POSITIONS[samples]) {
    const { elements, opaqueDepth, clearance, layers } = sampleReference(scene, x, y, offset);
    minClearance = Math.min(minClearance, clearance);
    maxLayers = Math.max(maxLayers, layers.length);
    const depths = opaqueDepth > 0 ? [...elements, { kind: 'opaque', index: -1, z: opaqueDepth }] : elements;
    for (let i = 0; i < depths.length; i++) for (let j = i + 1; j < depths.length; j++) {
      if (declaredTie(depths[i], depths[j])) { exactTies++; continue; }
      minMargin = Math.min(minMargin, Math.abs(depths[i].z - depths[j].z));
    }
  }
  return { minMargin, minClearance, exactTies, maxLayers };
}

/** Expected exhaustion for K layers: unpeeled samples and unpeeled glass fragments. */
export function expectedExhaustion(scene, samples, K) {
  let unpeeledSamples = 0, unpeeledFragments = 0;
  for (let y = 0; y < scene.size; y++) for (let x = 0; x < scene.size; x++) for (const offset of SAMPLE_POSITIONS[samples]) {
    const { order, layers } = sampleReference(scene, x, y, offset);
    if (layers.length <= K) continue;
    unpeeledSamples++;
    unpeeledFragments += order.filter(e => e.kind === 'glass' && e.z > layers[K - 1]).length;
  }
  return { exhausted: unpeeledSamples > 0, unpeeledSamples, unpeeledFragments };
}

/** Flat vertex data: x_ndc, y_ndc, z, primitive index (two triangles per rectangle). */
export function rectangleVertices(scene, rect, depthAt, index) {
  const [x0, y0, x1, y1] = rect, R = scene.R;
  return [[x0, y0], [x1, y0], [x0, y1], [x0, y1], [x1, y0], [x1, y1]].map(([X, Y]) => [X / R, -Y / R, depthAt(X, Y), index]);
}
