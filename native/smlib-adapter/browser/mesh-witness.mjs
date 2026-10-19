// SPDX-License-Identifier: MPL-2.0
// Mesh-derived section/surface witnesses; no analytic SDK identity is inferred.
import { assert, f64, u32 } from './contract.mjs';
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a.reduce((v, x, i) => v + x * b[i], 0);
function edgeDistance(p, a, b) {
  const d = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), d) / (dot(d, d) || 1)));
  return Math.hypot(...sub(p, a.map((v, i) => v + t * d[i])));
}
function triangleDistance(p, triangle) {
  const signs = triangle.map((a, i) => {
    const b = triangle[(i + 1) % 3];
    return (b[0]-a[0])*(p[1]-a[1]) - (b[1]-a[1])*(p[0]-a[0]);
  });
  // Degenerate projected wall triangles have no interior.
  const area = signs.reduce((a, b) => a + b, 0);
  if (Math.abs(area) > 1e-14 && (signs.every(v => v >= -1e-14) || signs.every(v => v <= 1e-14))) return 0;
  return Math.min(...triangle.map((a, i) => edgeDistance(p, a, triangle[(i + 1) % 3])));
}
export async function meshWitness(call, session, solid, expected, fixture, moved = false) {
  const pipe = fixture?.pipe;
  if (pipe) fixture = undefined;
  const mesh = await call(9, session, solid, f64(0.0001), f64(3));
  const info = new DataView((await call(10, session, mesh)).buffer);
  const vertices = info.getUint32(0, true), triangles = info.getUint32(4, true);
  assert(vertices > 0 && triangles > 0 && info.getUint32(8, true) > 0 &&
    [12, 16, 20].every(i => info.getUint32(i, true) === 0), 'complete closed retained tessellation');
  async function read(stream, count, width) {
    const bytes = new Uint8Array(count * width);
    for (let offset = 0; offset < count; offset += 480) {
      const chunk = await call(11, session, mesh, u32(stream), u32(offset), u32(Math.min(480, count - offset)));
      assert(chunk.length === Math.min(480, count - offset) * width, 'complete mesh chunk');
      bytes.set(chunk, offset * width);
    }
    return new DataView(bytes.buffer);
  }
  const positions = await read(1, vertices * 3, 8), indices = await read(2, triangles * 3, 4);
  const points = Array.from({ length: vertices }, (_, i) => {
    const p = [0, 1, 2].map(axis => positions.getFloat64((i * 3 + axis) * 8, true));
    assert(p.every(Number.isFinite), 'finite mesh position');
    // Inverse of the tested cyclic-axis rigid copy, including translation.
    return moved ? [p[1] - 20, p[2] - 30, p[0] - 10] : p;
  });
  let sixVolume = 0, surface = 0, sectionLength = 0, sectionTwiceArea = 0;
  let sectionSegments = 0;
  const sectionGraph = new Map();
  const sectionPoints = new Map();
  const sectionKey = p => p.map(v => {
    const rounded = v.toFixed(7);
    // toFixed preserves the sign of values rounded to zero. Both spellings
    // identify the same grid point; the seven-decimal grid stays unchanged.
    return rounded === '-0.0000000' ? '0.0000000' : rounded;
  }).join(',');
  function connect(a, b) {
    const key = sectionKey(a), value = sectionKey(b);
    if (!sectionGraph.has(key)) sectionGraph.set(key, []);
    if (!sectionPoints.has(key)) sectionPoints.set(key, a);
    sectionGraph.get(key).push(value);
  }
  const tolerance = 0.0005;
  const height = fixture ? fixture.direction[2] * fixture.depth : 0;
  const plane = height * 0.437;
  const project = p => [p[0] - p[2] * fixture.direction[0] / fixture.direction[2],
    p[1] - p[2] * fixture.direction[1] / fixture.direction[2]];
  if (fixture) {
    const [xmin, ymin, xmax, ymax] = fixture.bounds;
    const shift = fixture.direction.map(v => v * fixture.depth);
    const bounds = [[xmin + Math.min(0, shift[0]), xmax + Math.max(0, shift[0])],
      [ymin + Math.min(0, shift[1]), ymax + Math.max(0, shift[1])], [Math.min(0, height), Math.max(0, height)]];
    for (let axis = 0; axis < 3; axis++) {
      const actual = points.reduce(([lo, hi], p) => [Math.min(lo, p[axis]), Math.max(hi, p[axis])], [Infinity, -Infinity]);
      assert(actual.every((v, i) => Math.abs(v - bounds[axis][i]) < tolerance), `${fixture.name}: tight mesh bounds axis ${axis}`);
    }
    for (const p of points) if (Math.abs(p[2]) > tolerance && Math.abs(p[2] - height) > tolerance) assert(fixture.boundary(project(p)) < tolerance, `${fixture.name}: vertex on swept profile boundary`);
  }
  for (let triangle = 0; triangle < triangles; triangle++) {
    const p = [0, 1, 2].map(corner => {
      const index = indices.getUint32((triangle * 3 + corner) * 4, true);
      assert(index < vertices, 'retained triangle vertex'); return points[index];
    });
    sixVolume += dot(p[0], cross(p[1], p[2]));
    surface += Math.hypot(...cross(sub(p[1], p[0]), sub(p[2], p[0]))) / 2;
    if (!fixture) continue;
    const projected = p.map(project);
    for (const [x, y, radius] of fixture.holes) {
      assert(triangleDistance([x, y], projected) >= radius - tolerance,
        `${fixture.name}: no cap or wall triangle inside swept hole`);
    }
    const hits = [];
    p.forEach((a, i) => {
      const b = p[(i + 1) % 3];
      if ((a[2] < plane) !== (b[2] < plane)) {
        const t = (plane - a[2]) / (b[2] - a[2]);
        hits.push(project(a.map((v, axis) => v + t * (b[axis] - v))));
      }
    });
    if (hits.length === 2) {
      let [a, b] = hits;
      const normal = cross(sub(p[1], p[0]), sub(p[2], p[0]));
      const tangent = [normal[1], -normal[0]];
      if (dot(sub(b, a), tangent) < 0) [a, b] = [b, a];
      assert(hits.every(q => fixture.boundary(q) < tolerance), `${fixture.name}: section endpoints on profile boundary`);
      connect(a, b); connect(b, a);
      sectionLength += Math.hypot(...sub(b, a));
      sectionTwiceArea += a[0]*b[1] - b[0]*a[1]; sectionSegments++;
    }
  }
  const volume = Math.abs(sixVolume) / 6;
  assert(Math.abs(volume - expected) < expected * 0.002, 'independent triangle volume');
  if (fixture) {
    const visited = new Set();
    let loops = 0;
    for (const [key, neighbors] of sectionGraph) {
      if (neighbors.length !== 2) {
        const point = sectionPoints.get(key);
        let nearest;
        for (const [otherKey, other] of sectionPoints) if (otherKey !== key) {
          const distance = Math.hypot(...sub(point, other));
          if (!nearest || distance < nearest.distance) nearest = {
            key: otherKey, point: other, degree: sectionGraph.get(otherKey).length, distance,
          };
        }
        assert(false, `${fixture.name}: closed section boundary degree ${JSON.stringify({
          moved, key, point, degree: neighbors.length, neighbors, nearest,
        })}`);
      }
      if (visited.has(key)) continue;
      loops++;
      const pending = [key];
      while (pending.length) {
        const current = pending.pop();
        if (visited.has(current)) continue;
        visited.add(current); pending.push(...sectionGraph.get(current));
      }
    }
    assert(loops === fixture.loops, `${fixture.name}: section outer and hole loop count`);
    assert(sectionSegments > 0 && Math.abs(sectionLength - fixture.perimeter) < fixture.perimeter * 0.002,
      `${fixture.name}: mesh midsection boundary length including holes`);
    assert(Math.abs(Math.abs(sectionTwiceArea) / 2 - fixture.area) < fixture.area * 0.002,
      `${fixture.name}: oriented mesh midsection net area`);
    if (fixture.surface !== undefined) assert(Math.abs(surface - fixture.surface) < fixture.surface * 0.002,
      `${fixture.name}: independent triangle surface area`);
  }
  if (pipe) {
    for (let axis = 0; axis < 3; axis++) {
      const bounds = points.reduce(([lo, hi], p) => [Math.min(lo, p[axis]), Math.max(hi, p[axis])], [Infinity, -Infinity]);
      assert(bounds.every((v, i) => Math.abs(v - pipe.bounds[axis][i]) < tolerance),
        `rational quarter pipe: tight bounds axis ${axis}`);
    }
    for (const [x, y, z] of points) {
      const distance = Math.hypot(Math.hypot(x, y) - pipe.pathRadius, z);
      const cap = Math.abs(x) < tolerance || Math.abs(y) < tolerance;
      assert(x >= -tolerance && y >= -tolerance && (cap
        ? distance <= pipe.radius + tolerance : Math.abs(distance - pipe.radius) < tolerance),
        'rational quarter pipe: vertex on tube or endpoint cap');
    }
    assert(Math.abs(surface - pipe.surface) < pipe.surface * 0.002,
      'rational quarter pipe: independent tube and two-cap surface area');
  }
  await call(8, session, mesh);
  return { vertices, triangles, triangleVolume: volume, triangleSurfaceArea: surface,
    ...(pipe && { pipeShape: 'quarter-circle tube and endpoint caps' }),
    ...(fixture && { meshSectionLength: sectionLength, meshSectionArea: Math.abs(sectionTwiceArea) / 2 }) };
}
