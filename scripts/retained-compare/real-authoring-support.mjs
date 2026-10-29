// SPDX-License-Identifier: MPL-2.0
// Pure helpers for real-authoring.test.mjs; SMLib-free and covered by
// real-authoring-support.test.mjs in the ordinary lane.

/** Wavefront OBJ → Map<"IfcType_id", {vertices, triangles}>; repeated `o` blocks of one name concatenate. */
export function parseObj(text) {
  const all = [], objects = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('v ')) {
      const [x, y, z] = line.slice(2).trim().split(/\s+/).map(Number);
      if (![x, y, z].every(Number.isFinite)) throw new Error(`Nonfinite OBJ vertex: ${line}`);
      all.push([x, y, z]);
    } else if (line.startsWith('o ')) {
      const name = line.slice(2).trim();
      current = objects.get(name) ?? { vertices: all, triangles: [] };
      objects.set(name, current);
    } else if (line.startsWith('f ')) {
      if (!current) throw new Error('OBJ face before any object');
      const corners = line.slice(2).trim().split(/\s+/).map(c => Number(c.split('/')[0]) - 1);
      for (let i = 1; i + 1 < corners.length; i++) current.triangles.push([corners[0], corners[i], corners[i + 1]]);
    }
  }
  return objects;
}

/** Absolute enclosed volume, surface area and axis-aligned bounds of one parsed object. */
export function productMeasures({ vertices, triangles }) {
  let volume = 0, area = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  if (!triangles.length) throw new Error('OBJ object has no faces');
  const origin = vertices[triangles[0][0]];
  for (const tri of triangles) {
    const [a, b, c] = tri.map(i => {
      if (!vertices[i]) throw new Error(`OBJ face index ${i + 1} out of range`);
      return vertices[i];
    });
    for (const p of [a, b, c]) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    const u = a.map((v, k) => v - origin[k]), v = b.map((x, k) => x - origin[k]), w = c.map((x, k) => x - origin[k]);
    volume += (u[0] * (v[1] * w[2] - v[2] * w[1]) + u[1] * (v[2] * w[0] - v[0] * w[2]) + u[2] * (v[0] * w[1] - v[1] * w[0])) / 6;
    const e1 = v.map((x, k) => x - u[k]), e2 = w.map((x, k) => x - u[k]);
    area += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
  }
  return { volume: Math.abs(volume), area, min, max, triangles: triangles.length };
}

/**
 * Retained against exact for one product. The allowance is the deviation the native
 * comparison already measured for this product, plus the preregistered `exactLinear`
 * tolerances, plus what six-decimal OBJ coordinates can cost (5e-7 m per vertex).
 * Curved products are report only, as in tolerances.json (`exactCurved`).
 */
export function compareProduct(retained, exact, nativeRow, { volumeRelative, bboxMetres }) {
  if (nativeRow.curved === 'true') return { skipped: 'curved', ok: true };
  if (!(exact.volume > 0)) return { skipped: 'degenerate exact volume', ok: true };
  const measured = Number(nativeRow.exact_vol_rel), measuredBbox = Number(nativeRow.exact_bbox_dev_m);
  const relative = Math.abs(retained.volume - exact.volume) / exact.volume;
  const allowed = (Number.isFinite(measured) ? measured : 0) + volumeRelative + 1e-6 * exact.area / exact.volume;
  const bboxDeviation = Math.max(...retained.min.map((v, k) => Math.abs(v - exact.min[k])), ...retained.max.map((v, k) => Math.abs(v - exact.max[k])));
  const allowedBbox = (Number.isFinite(measuredBbox) ? measuredBbox : 0) + bboxMetres + 1e-6;
  return { ok: relative <= allowed && bboxDeviation <= allowedBbox, relative, allowed, bboxDeviation, allowedBbox };
}

/** `#id=IFCTYPE('GlobalId',…` for every rooted entity of a STEP file → Map<id, {type, globalId}>. */
export function sourceIdentity(source) {
  const rows = new Map();
  for (const m of source.matchAll(/^#(\d+)\s*=\s*(IFC[A-Z0-9]+)\(\s*'((?:[^']|'')*)'/gm)) {
    rows.set(Number(m[1]), { type: m[2], globalId: m[3].replace(/''/g, "'") });
  }
  return rows;
}
