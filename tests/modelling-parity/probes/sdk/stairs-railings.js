/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: stairs-railings (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle (Revit stair by component + railing, Archicad stair tool): a straight stair from
// Level 1 lands exactly on Level 2, refits its risers when the floor-to-floor changes, and a
// 0.9 m railing runs along it and follows the refit.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'stairs-railings');
const S = bim.store, M = t.M, L1 = t.ground();
t.step('Level 2', () => S.addStorey(M, { Name: 'Level 2', Elevation: 3.0, referenceStoreyId: L1.expressId }));
const stair = t.step('stair', () => S.addStair(M, L1.expressId, { Position: [6, 1, 0], Direction: Math.PI / 2, NumberOfRisers: 17, RiserHeight: 3.0 / 17, TreadLength: 0.27, Width: 1.0 }));
let x = await t.exportModel('stairs-drawn');
const sb = x.bbox(stair, true);
t.check('stair lands on the next storey', () => (sb && P.near(sb.max[2], 3.0, 0.01)) || `stair top at ${P.fmt(sb?.max[2])} m, Level 2 at 3`, { core: true });
const side = sb ? sb.max[0] + 0.05 : 7.05, run = sb ? [sb.min[1], sb.max[1]] : [1, 5.3];
const rail = t.step('railing', () => S.addRailing(M, L1.expressId, { Path: [[side, run[0], 0], [side, run[1], 3.0]], Height: 0.9 }));
x = await t.exportModel('stairs-railing');
t.check('railing runs 0.9 m above the stair', () => {
  const b = x.bbox(rail);
  return (b && P.near(b.max[2], 3.9, 0.05) && P.near(b.min[2], 0, 0.1)) || `railing spans ${P.fmt(b?.min[2])}..${P.fmt(b?.max[2])} m`;
});
const plan = t.step('plan 3.3 m', () => S.planStoreyEdit(M, { kind: 'floorHeight', storeyId: L1.expressId, Height: 3.3 }));
t.step('apply 3.3 m', () => S.editStorey(M, { kind: 'floorHeight', storeyId: L1.expressId, Height: 3.3 }, plan));
x = await t.exportModel();
t.check('stair refits to the new floor-to-floor', () => {
  const b = x.bbox(stair, true);
  return (b && P.near(b.max[2], 3.3, 0.01)) || `stair top at ${P.fmt(b?.max[2])} m after Level 2 moved to 3.3`;
});
t.check('railing follows the stair refit', () => P.near(x.bbox(rail)?.max[2], 4.2, 0.05) || `railing top at ${P.fmt(x.bbox(rail)?.max[2])} m, expected 4.2 over the refitted stair`);
t.metrics.risers = plan?.stairs?.[0] ? JSON.stringify(plan.stairs[0]).slice(0, 120) : null;
t.done();
