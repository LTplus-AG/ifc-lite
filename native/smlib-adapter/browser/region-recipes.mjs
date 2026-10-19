// SPDX-License-Identifier: MPL-2.0
// Derived numerical evaluation recipes, not source IFC interpretation qualification.
const tau = 2 * Math.PI;
const line = (a, b) => ({ kind: 1, values: [...a, 0, ...b, 0, 0, 0, 0, 0, 0, 0] });
const arc = (x, y, radius, sweep = tau, normal = 1, start = 0, basis = 0) => ({
  kind: Math.abs(sweep) === tau ? 2 : 3,
  values: [x, y, 0, 0, 0, normal, Math.cos(basis), Math.sin(basis), 0, radius, start, sweep],
});
const polygon = (points) => points.map((a, i) => line(a, points[(i + 1) % points.length]));
export function regionRecipe(loops, direction = [0, 0, 1], depth = 3) {
  const segments = loops.reduce((n, loop) => n + loop.length, 0);
  const bytes = new Uint8Array(48 + 8 * loops.length + 104 * segments), view = new DataView(bytes.buffer);
  [1, loops.length, segments, 0].forEach((n, i) => view.setUint32(i * 4, n, true));
  [...direction, depth].forEach((n, i) => view.setFloat64(16 + i * 8, n, true));
  let offset = 48;
  loops.forEach((loop, i) => {
    view.setUint32(offset, i === 0 ? 0 : 1, true);
    view.setUint32(offset + 4, loop.length, true); offset += 8;
    for (const segment of loop) {
      view.setUint32(offset, segment.kind, true);
      segment.values.forEach((n, j) => view.setFloat64(offset + 8 + j * 8, n, true));
      offset += 104;
    }
  });
  return { recipe: bytes, loops: loops.length, segments, format: 1 };
}
export function regionWitnesses() {
  const cases = [];
  function add(name, loops, area, perimeter, bounds, boundary, holes = [], direction = [0, 0, 1], depth = 3) {
    cases.push({ name, ...regionRecipe(loops, direction, depth), area, perimeter, bounds,
      boundary, holes, direction, depth, expected: area * depth * Math.abs(direction[2]),
      surface: direction[2] === 1 ? 2 * area + perimeter * depth : undefined });
  }
  const radial = (radius) => ([x, y]) => Math.abs(Math.hypot(x, y) - radius);
  add('reverse-circle', [[arc(0, 0, 2, -tau)]], 4 * Math.PI, 4 * Math.PI,
    [-2, -2, 2, 2], radial(2));
  add('negative-normal-circle-rotated-frame', [[arc(0, 0, 2, tau, -1, 0.37, 0.61)]],
    4 * Math.PI, 4 * Math.PI, [-2, -2, 2, 2], radial(2));
  for (const normal of [1, -1]) {
    add(`annulus-normal-${normal}`, [[arc(0, 0, 2, normal * tau, normal)],
      [arc(0, 0, 1, -normal * tau, normal)]], 3 * Math.PI, 6 * Math.PI,
    [-2, -2, 2, 2], p => Math.min(radial(2)(p), radial(1)(p)), [[0, 0, 1]]);
  }
  // Two quarter arcs with nonzero trims and a closing diameter form a half disk.
  add('trimmed-composite-arcs-line', [[arc(0, 0, 2, Math.PI / 2, 1, 0, Math.PI / 2),
    arc(0, 0, 2, Math.PI / 2, 1, Math.PI / 2, Math.PI / 2), line([0, -2], [0, 2])]],
  2 * Math.PI, 2 * Math.PI + 4, [-2, -2, 0, 2],
  ([x, y]) => Math.min(Math.abs(Math.hypot(x, y) - 2), Math.abs(x)));
  const outer = polygon([[-4, -3], [4, -3], [4, 3], [-4, 3]]);
  const holes = [[-2, 0, 0.75], [1.5, 0.5, 1]];
  const boundary = ([x, y]) => Math.min(Math.abs(Math.abs(x) - 4), Math.abs(Math.abs(y) - 3),
    ...holes.map(([cx, cy, r]) => Math.abs(Math.hypot(x - cx, y - cy) - r)));
  add('two-circular-holes', [outer, ...holes.map(([x, y, r]) => [arc(x, y, r, -tau)])],
    48 - 1.5625 * Math.PI, 28 + 3.5 * Math.PI, [-4, -3, 4, 3], boundary, holes);
  add('oblique-annulus', [[arc(0, 0, 2)], [arc(0, 0, 1, -tau)]], 3 * Math.PI,
    6 * Math.PI, [-2, -2, 2, 2], p => Math.min(radial(2)(p), radial(1)(p)), [[0, 0, 1]], [0.6, 0, 0.8]);
  // Millimetre-derived dimensions are explicitly converted to metres by this recipe.
  const mm = 0.001, radius = 2000 * mm, inner = 750 * mm;
  add('millimetre-derived-annulus', [[arc(0, 0, radius)], [arc(0, 0, inner, -tau)]],
    Math.PI * (radius ** 2 - inner ** 2), tau * (radius + inner), [-2, -2, 2, 2],
    p => Math.min(radial(radius)(p), radial(inner)(p)), [[0, 0, inner]], [0, 0, 1], 1250 * mm);
  return cases;
}
