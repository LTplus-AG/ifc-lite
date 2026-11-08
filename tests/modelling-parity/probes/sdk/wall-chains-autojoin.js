/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: wall-chains-autojoin (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle: walls drawn end to end as a closed chain join at their corners like Revit/Archicad
// walls do (clean L corners: the outer corner is filled, the inner corner is not doubled), and
// a partition meeting a wall forms a T. Checked by point-in-solid tests on the exported meshes.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'wall-chains-autojoin');
const S = bim.store, M = t.M, L1 = t.ground();
const T = 0.25, H = 3, C = [[0, 0], [10, 0], [10, 8], [0, 8]];
const walls = C.map((c, i) => t.step(`wall ${i}`, () => S.addWall(M, L1.expressId, { Start: [...c, 0], End: [...C[(i + 1) % 4], 0], Thickness: T, Height: H, Name: `W${i}` })));
const part = t.step('partition', () => S.addWall(M, L1.expressId, { Start: [5, 0, 0], End: [5, 8, 0], Thickness: 0.12, Height: H, Name: 'Partition' }));
const all = [...walls, part].filter(Boolean);
const inside = (x, p) => all.filter((w) => x.contains(w, p)).length;
const corners = (x) => C.map(([cx, cy]) => {
  const sx = cx === 0 ? -1 : 1, sy = cy === 0 ? -1 : 1, d = 0.06;
  return { outer: inside(x, [cx + sx * d, cy + sy * d, 1.5]), inner: inside(x, [cx - sx * d, cy - sy * d, 1.5]) };
});
const clean = (cs) => cs.every((c) => c.outer === 1 && c.inner === 1);
let x = await t.exportModel('wall-chains-drawn');
const drawn = corners(x);
t.check('a drawn chain joins automatically', () => (clean(drawn) && x.count('IFCRELCONNECTSPATHELEMENTS') >= 4) || `as drawn: ${x.count('IFCRELCONNECTSPATHELEMENTS')} IfcRelConnectsPathElements; corner fill/overlap counts ${JSON.stringify(drawn)}`);
for (let i = 0; i < 4; i++) t.step(`join ${i}`, () => S.joinWalls(M, walls[i].expressId, walls[(i + 1) % 4].expressId));
t.step('join partition', () => S.joinWalls(M, part.expressId, walls[0].expressId));
t.step('join partition north', () => S.joinWalls(M, part.expressId, walls[2].expressId));
x = await t.exportModel();
const joined = corners(x);
t.check('explicit joins give clean L corners', () => clean(joined) || `corner fill/overlap counts after joinWalls ${JSON.stringify(joined)}`);
t.check('a partition meeting a wall forms a clean T', () => {
  const a = inside(x, [5, 0.05, 1.5]), b = inside(x, [5, 7.95, 1.5]), gap = inside(x, [5, 0.2, 1.5]);
  return (a === 1 && b === 1 && gap === 1) || `points at the T junctions are inside ${a}/${b} walls, just inside the room ${gap}`;
});
t.done();
