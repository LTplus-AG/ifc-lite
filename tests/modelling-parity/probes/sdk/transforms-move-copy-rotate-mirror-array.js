/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: transforms-move-copy-rotate-mirror-array (#9296). Run by ./run.mjs.
// Oracle (Revit Modify tools, Archicad Drag/Rotate/Mirror/Multiply): move, rotate about a
// pivot, copy, mirror about an axis, linear array and polar array each put the element where
// the typed values say, checked on exported mesh boxes.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'transforms-move-copy-rotate-mirror-array');
const S = bim.store, M = t.M, L1 = t.ground();
const col = () => S.addColumn(M, L1.expressId, { Position: [6, 0, 0], Width: 0.4, Depth: 0.4, Height: 3 });
const mv = t.step('column to move', col);
const wall = t.step('wall to rotate', () => S.addWall(M, L1.expressId, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 }));
const src = t.step('column to copy', () => S.addColumn(M, L1.expressId, { Position: [0, 8, 0], Width: 0.4, Depth: 0.4, Height: 3 }));
const asym = t.step('wall to mirror', () => S.addWall(M, L1.expressId, { Start: [10, 1, 0], End: [13, 1, 0], Thickness: 0.2, Height: 3 }));
t.step('move', () => S.transformElements(M, [mv.expressId], { kind: 'move', delta: [1, 2] }));
t.step('rotate', () => S.transformElements(M, [wall.expressId], { kind: 'rotate', pivot: [0, 0], angle: Math.PI / 2 }));
const copies = t.step('copy', () => S.copyElements(M, [src.expressId], [{ offset: [0, 3, 0] }])) ?? [];
const mirrorFn = ['mirrorElements', 'mirror'].find((k) => typeof S[k] === 'function');
const mirrored = mirrorFn ? t.step('mirror', () => S[mirrorFn](M, [asym.expressId], { axis: [[9, -10], [9, 10]], copy: true })) : null;
const lin = t.step('linear array', () => S.arrayElements(M, [src.expressId], { mode: 'linear', count: 4, anchor: [0, 8], cursor: [1, 8], distance: 2 })) ?? [];
const polar = t.step('polar array', () => S.arrayElements(M, [mv.expressId], { mode: 'polar', count: 4, anchor: [0, 0], angleDegrees: 360 })) ?? [];
const x = await t.exportModel();
const c = (r) => x.bbox(r)?.centre;
const at = (r, px, py) => { const p = c(r); return p && P.near(p[0], px, 2e-3) && P.near(p[1], py, 2e-3); };
t.check('move by a typed vector', () => at(mv, 7, 2) || `moved column centre ${P.fmt(c(mv))}, expected [7, 2]`, { core: true });
t.check('rotate about a pivot', () => { const b = x.bbox(wall); return (b && P.near(b.centre[0], 0, 2e-3) && P.near(b.centre[1], 2, 2e-3) && P.near(b.size[1], 4, 2e-3)) || `rotated wall box ${P.fmt(b?.min)}..${P.fmt(b?.max)}`; });
t.check('copy by a typed vector', () => (copies.length === 1 && at(copies[0], 0, 11)) || `copies ${copies.length} at ${P.fmt(copies[0] && c(copies[0]))}`);
t.check('mirror about an axis', () => {
  if (!mirrorFn) return 'no SDK mirror operation (bim.store has no mirrorElements)';
  const b = x.bbox((mirrored ?? [])[0]);
  return (b && P.near(b.min[0], 5, 2e-3) && P.near(b.max[0], 8, 2e-3)) || `mirrored copy box ${P.fmt(b?.min)}..${P.fmt(b?.max)}`;
});
t.check('linear array at a typed spacing', () => {
  const xs = lin.map((r) => c(r)?.[0]).filter(Number.isFinite).sort((a, b) => a - b);
  return (xs.length === 3 && P.near(xs[0], 2, 2e-3) && P.near(xs[2], 6, 2e-3)) || `array copies at x ${P.fmt(xs)}`;
});
t.check('polar array about a centre', () => {
  const pts = polar.map((r) => c(r)).filter(Boolean).map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).sort();
  return pts.join(' ') === '-2,7 -7,-2 2,-7'.split(' ').sort().join(' ') || `polar copies at ${pts.join(' ')} (expected -2,7 -7,-2 2,-7)`;
});
t.done();
