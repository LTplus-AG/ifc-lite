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
    if (meshProduct.meshes.length !== product.parts.length) { fail('shape/view part count mismatch'); continue; }
    for (const [partIndex, part] of product.parts.entries()) {
      const mesh = meshProduct.meshes[partIndex], m = part.worldFromObject;
      if (mesh.expressId !== product.expressId) fail('mesh belongs to another product');
      if (mesh.indices.length !== part.indices.length || mesh.positions.length !== part.indices.length * 3) {
        fail('view triangle count or unwelded vertex count mismatch'); continue;
      }
      if (!same(mesh.rtcOffset, view.start.frame.rtcOffset)) fail('mesh RTC differs from start');
      const origin = zUp(mesh.origin), rtc = view.start.frame.rtcOffset;
      triangles += part.indices.length / 3;
      for (let corner = 0; corner < part.indices.length; corner++) {
        if (mesh.indices[corner] !== corner) fail('view triangle indices are not unwelded');
        const at = part.indices[corner] * 3, p = part.positions.slice(at, at + 3);
        const local = zUp(mesh.positions.slice(corner * 3, corner * 3 + 3));
        vertices++;
        for (let axis = 0; axis < 3; axis++) {
          const expected = m[axis] * p[0] + m[4 + axis] * p[1] + m[8 + axis] * p[2] + m[12 + axis];
          const actual = (origin[axis] + local[axis]) + rtc[axis];
          const deviation = vertexDeviation(actual, expected, local[axis]);
          maxVertexMetres = Math.max(maxVertexMetres, deviation.error);
          maxVertexUlps = Math.max(maxVertexUlps, deviation.ulps);
          if (!deviation.valid) fail(`part ${partIndex} vertex ${corner} axis ${axis}: ${deviation.ulps} ulp (${deviation.error} m)`);
        }
      }
    }
  }
  return { vertices, triangles, maxVertexMetres, maxVertexUlps, violations };
}
