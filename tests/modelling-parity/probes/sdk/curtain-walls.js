/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: curtain-walls (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle (Revit/Archicad curtain wall with a U/V grid): a 6 x 3 m curtain wall with 4 x 2 bays
// is an IfcCurtainWall aggregate of 8 panels plus mullions and transoms filling its extent, and
// its top follows the storey above like a wall's top constraint.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'curtain-walls');
const S = bim.store, M = t.M, L1 = t.ground();
const L2 = t.step('Level 2', () => S.addStorey(M, { Name: 'Level 2', Elevation: 3.0, referenceStoreyId: L1.expressId }));
const cw = t.step('curtain wall', () => S.addCurtainWall(M, L1.expressId, { Start: [0, 0, 0], End: [6, 0, 0], Height: 3.0, UGrid: 4, VGrid: 2, Name: 'CW' }));
const parts = cw ? bim.decomposes(cw) : [];
const kinds = {};
for (const p of parts) kinds[p.type] = (kinds[p.type] ?? 0) + 1;
let x = await t.exportModel('curtain-walls-drawn');
t.check('grid of 8 panels with mullions and transoms', () => (kinds.IfcPlate === 8 && (kinds.IfcMember ?? 0) >= 8) || `parts ${JSON.stringify(kinds)}`, { core: true });
t.check('panels and members fill the wall extent', () => {
  const b = x.bbox(cw, true);
  return (b && P.near(b.size[0], 6, 0.08) && P.near(b.max[2], 3.0, 0.08) && P.near(b.min[2], 0, 0.08)) || `aggregate box ${P.fmt(b?.min)}..${P.fmt(b?.max)}`;
});
t.step('attach top', () => bim.mutate.setProperty(cw, 'IfcLite_StoreyAttachment', 'TopConstraint', t.globalId(L2), 'IfcLabel'));
t.step('floor-to-floor 4 m', () => S.editStorey(M, { kind: 'floorHeight', storeyId: L1.expressId, Height: 4.0 }));
x = await t.exportModel();
t.check('top follows the storey above', () => P.near(x.bbox(cw, true)?.max[2], 4.0, 0.08) || `after Level 2 moved to 4 m the curtain wall top is at ${P.fmt(x.bbox(cw, true)?.max[2])} m`);
t.done();
