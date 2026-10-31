// SPDX-License-Identifier: MPL-2.0
// #7955 M2-D: compare BEFORE rounding world coordinates to storage precision.
export function float32Ulp(value) {
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude) || Math.fround(value) !== value) return NaN;
  return magnitude < 2 ** -126 ? 2 ** -149 : 2 ** (Math.floor(Math.log2(magnitude)) - 23);
}

export function vertexDeviation(actual, expected, stored) {
  const error = Math.abs(actual - expected);
  const ulp = float32Ulp(stored);
  return { error, ulps: error / ulp, valid: Number.isFinite(error) && Number.isFinite(ulp) && error <= ulp / 2 };
}

const zUp = ([x, y, z]) => [x, -z, y];
const same = (a, b) => a?.length === b?.length && a.every((v, i) => Object.is(v, b[i]));

// Rotate so the lexicographically smallest corner leads; winding is kept (no sorting), so orientation is still compared.
function canonicalTriangle(corners, pointOf) {
  const less = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
  let first = 0;
  for (let k = 1; k < 3; k++) if (less(pointOf(corners[k]), pointOf(corners[first]))) first = k;
  return [0, 1, 2].map(k => corners[(first + k) % 3]);
}
const triangleKey = (triangle, pointOf) => triangle.map(c => pointOf(c).join(',')).join(';');

/**
 * One view mesh per shape part, rejoining a part the view split by palette colour or
 * textured state (#8291): meshes are consumed in order until they hold exactly the part's
 * triangles. `null` when they cannot land on it, or a split changed the origin.
 */
function rejoinParts(parts, meshes) {
  const joined = [];
  let next = 0;
  for (const part of parts) {
    const first = meshes[next];
    if (!first) return null;
    let merged = first, count = first.indices?.length ?? 0;
    next++;
    while (count < part.indices.length && meshes[next]) {
      const more = meshes[next++];
      if (!same(more.origin, first.origin) || !same(more.rtcOffset, first.rtcOffset) || more.expressId !== first.expressId) return null;
      const offset = merged.positions.length / 3;
      merged = { ...merged, positions: [...merged.positions, ...more.positions],
        indices: [...merged.indices, ...Array.from(more.indices, index => index + offset)] };
      count += more.indices.length;
    }
    joined.push(merged);
  }
  return next === meshes.length ? joined : null;
}

export function compareView(shape, view, prepass) {
  const violations = [];
  let vertices = 0, triangles = 0, maxVertexMetres = 0, maxVertexUlps = 0;
  for (const run of [shape, view]) {
    if (!run.start || run.start.frame.needsShift !== prepass.needsShift ||
        !same(run.start.frame.rtcOffset, prepass.rtcOffset)) violations.push('view frame differs from buildPrePassOnce');
    if (!same(run.start?.candidateIds, run.outcomes.map(p => p.expressId))) violations.push('candidate/outcome order or universe mismatch');
  }
  if (!same(shape.start?.candidateIds, view.start?.candidateIds)) violations.push('shape/view product universe mismatch');
  const observed = new Map(view.outcomes.map(p => [p.expressId, p]));
  for (const product of shape.outcomes) {
    const meshProduct = observed.get(product.expressId);
    const fail = message => violations.push(`#${product.expressId}: ${message}`);
    if (!meshProduct || product.status !== meshProduct.status || product.code !== meshProduct.code) {
      fail('shape/view status or code mismatch'); continue;
    }
    if (product.status !== 'published') {
      if (meshProduct.meshes?.length || product.parts?.length) fail('refused product has geometry');
      continue;
    }
    const partMeshes = rejoinParts(product.parts, meshProduct.meshes);
    if (!partMeshes) { fail('shape/view part count mismatch'); continue; }
    for (const [partIndex, part] of product.parts.entries()) {
      const mesh = partMeshes[partIndex], m = part.worldFromObject;
      if (mesh.expressId !== product.expressId) fail('mesh belongs to another product');
      if (mesh.indices.length !== part.indices.length || mesh.positions.length !== part.indices.length * 3) {
        fail('view triangle count or unwelded vertex count mismatch'); continue;
      }
      if (!same(mesh.rtcOffset, view.start.frame.rtcOffset)) fail('mesh RTC differs from start');
      const origin = zUp(mesh.origin), rtc = view.start.frame.rtcOffset;
      triangles += part.indices.length / 3;
      for (let corner = 0; corner < mesh.indices.length; corner++) {
        if (mesh.indices[corner] !== corner) fail('view triangle indices are not unwelded');
      }
      vertices += part.indices.length;
      // Triangle order is not part of the API contract, so pair triangles by content, never by position.
      const viewTriangles = [], shapeTriangles = [];
      for (let t = 0; t < part.indices.length / 3; t++) {
        const viewCorners = [], shapeCorners = [];
        for (let k = 0; k < 3; k++) {
          const corner = t * 3 + k, at = part.indices[corner] * 3, p = part.positions.slice(at, at + 3);
          const local = zUp(mesh.positions.slice(corner * 3, corner * 3 + 3));
          const expected = [0, 1, 2].map(axis => m[axis] * p[0] + m[4 + axis] * p[1] + m[8 + axis] * p[2] + m[12 + axis]);
          viewCorners.push({ local, actual: local.map((v, axis) => (origin[axis] + v) + rtc[axis]) });
          // Matching key only: the stored f32 local coordinate the expected point rounds to. Deviation is checked in f64.
          shapeCorners.push({ expected, key: expected.map((v, axis) => Math.fround((v - rtc[axis]) - origin[axis])) });
        }
        viewTriangles.push(canonicalTriangle(viewCorners, c => c.local));
        shapeTriangles.push(canonicalTriangle(shapeCorners, c => c.key));
      }
      const pool = new Map();
      for (const shapeTriangle of shapeTriangles) {
        const key = triangleKey(shapeTriangle, c => c.key);
        if (!pool.has(key)) pool.set(key, []);
        pool.get(key).push(shapeTriangle);
      }
      const pending = [];
      const check = (viewTriangle, shapeTriangle, label) => {
        let ok = true;
        for (let k = 0; k < 3; k++) for (let axis = 0; axis < 3; axis++) {
          const v = viewTriangle[k], deviation = vertexDeviation(v.actual[axis], shapeTriangle[k].expected[axis], v.local[axis]);
          maxVertexMetres = Math.max(maxVertexMetres, deviation.error);
          maxVertexUlps = Math.max(maxVertexUlps, deviation.ulps);
          if (!deviation.valid) { ok = false; fail(`part ${partIndex} ${label} corner ${k} axis ${axis}: ${deviation.ulps} ulp (${deviation.error} m)`); }
        }
        return ok;
      };
      viewTriangles.forEach((viewTriangle, t) => {
        const bucket = pool.get(triangleKey(viewTriangle, c => c.local));
        if (bucket?.length) check(viewTriangle, bucket.pop(), `triangle ${t}`);
        else pending.push([t, viewTriangle]);
      });
      // Anything unmatched is reported, never skipped: pair it with its nearest unused shape triangle (any winding-preserving
      // rotation) and apply the same strict check, so a displaced corner shows its deviation instead of disappearing.
      const unused = [...pool.values()].flat();
      for (const [t, viewTriangle] of pending) {
        let best, bestScore = Infinity, bestAt = -1;
        unused.forEach((shapeTriangle, at) => {
          for (let r = 0; r < 3; r++) {
            const rotated = [0, 1, 2].map(k => shapeTriangle[(k + r) % 3]);
            let score = 0;
            for (let k = 0; k < 3; k++) for (let axis = 0; axis < 3; axis++) {
              score = Math.max(score, Math.abs(viewTriangle[k].actual[axis] - rotated[k].expected[axis]) / float32Ulp(viewTriangle[k].local[axis]));
            }
            if (score < bestScore) { bestScore = score; best = rotated; bestAt = at; }
          }
        });
        if (!best) { fail(`part ${partIndex} triangle ${t}: no shape triangle matches`); continue; }
        unused.splice(bestAt, 1);
        check(viewTriangle, best, `triangle ${t} (unmatched; nearest shape triangle)`);
      }
    }
  }
  return { vertices, triangles, maxVertexMetres, maxVertexUlps, violations };
}
