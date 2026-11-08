/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: slab-with-openings (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle: an L-shaped slab from a sketched outline, a shaft opening that really voids it,
// and a thickness edit that keeps the opening (Revit floor + shaft, Archicad slab + hole).
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'slab-with-openings');
const S = bim.store, M = t.M, L1 = t.ground();
const outline = [[0, 0], [10, 0], [10, 6], [6, 6], [6, 10], [0, 10]];
const area = 100 - 16, hole = 1.5 * 2;
const slab = t.step('L slab', () => S.addSlab(M, L1.expressId, { Profile: 'polygon', OuterCurve: outline, Thickness: 0.25, Name: 'L slab' }));
let x = await t.exportModel('slab-outline');
t.check('slab follows the sketched outline', () => {
  const b = x.bbox(slab), v = x.volume(slab);
  return (b && P.near(b.size[0], 10, 2e-3) && P.near(b.size[1], 10, 2e-3) && P.near(v, area * 0.25, 0.01)) || `bbox ${P.fmt(b?.size)}, volume ${P.fmt(v)} m³ (expected ${area * 0.25})`;
});
const open = t.step('shaft opening', () => S.addOpening(M, slab.expressId, { Position: [3, 3], Width: 1.5, Depth: 2, Name: 'Shaft' }));
x = await t.exportModel('slab-opening');
const z = (x.bbox(slab)?.min[2] + x.bbox(slab)?.max[2]) / 2;
t.check('opening voids the slab', () => {
  const v = x.volume(slab);
  return (open && !x.contains(slab, [3, 3, z]) && x.contains(slab, [4.5, 3, z]) && P.near(v, (area - hole) * 0.25, 0.01)) || `point in the shaft is ${x.contains(slab, [3, 3, z]) ? 'still solid' : 'void'}; volume ${P.fmt(v)} m³ (expected ${(area - hole) * 0.25})`;
});
t.step('thicken slab', () => S.setElementSize({ modelId: M, expressId: slab.expressId }, { kind: 'slab', Thickness: 0.3 }));
x = await t.exportModel();
t.check('thickness edit keeps the opening', () => {
  const v = x.volume(slab), b = x.bbox(slab), zc = (b.min[2] + b.max[2]) / 2;
  return (P.near(b.size[2], 0.3, 2e-3) && !x.contains(slab, [3, 3, zc]) && P.near(v, (area - hole) * 0.3, 0.01)) || `after thickening: depth ${P.fmt(b?.size[2])} m, volume ${P.fmt(v)} m³ (expected ${(area - hole) * 0.3})`;
});
t.done();
