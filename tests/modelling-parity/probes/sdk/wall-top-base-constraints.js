/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: wall-top-base-constraints (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle (Revit Base/Top Constraint + offsets, Archicad Home storey + Top link): a wall's top
// follows the storey it is attached to, a top offset is kept, the base follows its own storey,
// and a wall top can attach to a roof or slab.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'wall-top-base-constraints');
const S = bim.store, M = t.M, L1 = t.ground();
const L2 = t.step('Level 2', () => S.addStorey(M, { Name: 'Level 2', Elevation: 3.0, referenceStoreyId: L1.expressId }));
const L3 = t.step('Level 3', () => S.addStorey(M, { Name: 'Level 3', Elevation: 6.0 }));
const attach = (w, target) => bim.mutate.setProperty(w, 'IfcLite_StoreyAttachment', 'TopConstraint', target, 'IfcLabel');
const top = t.step('attached wall', () => S.addWall(M, L1.expressId, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3.0, Name: 'Top to L2' }));
const off = t.step('offset wall', () => S.addWall(M, L1.expressId, { Start: [0, 2, 0], End: [5, 2, 0], Thickness: 0.2, Height: 2.8, Name: 'Top to L2 -0.2' }));
const upper = t.step('upper wall', () => S.addWall(M, L2.expressId, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3.0, Name: 'L2 wall' }));
t.step('attach tops', () => { attach(top, t.globalId(L2)); attach(off, t.globalId(L2)); attach(upper, t.globalId(L3)); });
const roof = t.step('slab under L2', () => S.addSlab(M, L2.expressId, { Position: [0, 4, 0], Width: 5, Depth: 2, Thickness: 0.3, ExtrudedDirection: [0, 0, -1], Name: 'Floor slab' }));
const toSlab = t.step('wall under slab', () => S.addWall(M, L1.expressId, { Start: [0, 5, 0], End: [5, 5, 0], Thickness: 0.2, Height: 3.4, Name: 'Top to slab' }));
t.step('attach to slab', () => attach(toSlab, t.globalId(roof)));
t.step('raise Level 2', () => S.editStorey(M, { kind: 'elevation', storeyId: L2.expressId, Elevation: 3.4 }));
const x = await t.exportModel();
const z = (w) => x.bbox(w);
t.check('top follows its attached storey', () => P.near(z(top)?.max[2], 3.4, 2e-3) || `wall top at ${P.fmt(z(top)?.max[2])} m after Level 2 moved to 3.4 m`);
t.check('top offset is kept', () => P.near(z(off)?.max[2], 3.2, 2e-3) || `a wall 0.2 m below Level 2 has its top at ${P.fmt(z(off)?.max[2])} m after Level 2 moved to 3.4 m (expected 3.2)`);
t.check('base follows its own storey', () => (P.near(z(upper)?.min[2], 3.4, 2e-3) && P.near(z(upper)?.max[2], 6.0, 2e-3)) || `Level 2 wall spans ${P.fmt(z(upper)?.min[2])}..${P.fmt(z(upper)?.max[2])} m (expected 3.4..6)`);
t.check('top attaches to a slab or roof', () => P.near(z(toSlab)?.max[2], 3.1, 2e-3) || `a wall attached to the slab underside (3.1 m) has its top at ${P.fmt(z(toSlab)?.max[2])} m`);
t.done();
