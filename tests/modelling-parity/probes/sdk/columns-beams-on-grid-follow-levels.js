// Modelling parity SDK probe: columns-beams-on-grid-follow-levels (#9296). Run by ./run.mjs.
// Oracle (Revit columns with Top Level, beams on a reference level; Archicad columns linked
// to the storey above): columns placed on grid crossings keep them, a column's top follows
// the storey above when a floor-to-floor height changes, and a beam stays on its level.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'columns-beams-on-grid-follow-levels');
const S = bim.store, M = t.M, L1 = t.ground();
const L2 = t.step('Level 2', () => S.addStorey(M, { Name: 'Level 2', Elevation: 3.5, referenceStoreyId: L1.expressId }));
t.step('Level 3', () => S.addStorey(M, { Name: 'Level 3', Elevation: 7.0 }));
const grid = t.step('grid', () => S.addGrid(M, L1.expressId, {
  UAxes: [0, 6].map((x, i) => ({ Tag: 'AB'[i], Start: [x, -1], End: [x, 7] })),
  VAxes: [0, 6].map((y, i) => ({ Tag: String(i + 1), Start: [-1, y], End: [7, y] })),
}));
const axis = Object.fromEntries(bim.query().byType('IfcGridAxis').toArray().map((a) => [bim.attributes(a.ref).find((v) => v.name === 'AxisTag')?.value, a.ref.expressId]));
const at = [['A', '1', 0, 0], ['B', '1', 6, 0], ['A', '2', 0, 6], ['B', '2', 6, 6]];
const cols = at.map(([u, v, x, y]) => t.step(`column ${u}${v}`, () => S.addColumnOnGrid(M, L1.expressId, { Position: [x, y, 0], Width: 0.4, Depth: 0.4, Height: 3.5 }, { GridId: grid.expressId, IntersectingAxes: [axis[u], axis[v]] })));
for (const c of cols) if (c) t.step('attach column top', () => bim.mutate.setProperty(c, 'IfcLite_StoreyAttachment', 'TopConstraint', t.globalId(L2), 'IfcLabel'));
const beam = t.step('beam on Level 2', () => S.addBeam(M, L2.expressId, { Start: [0, 0, -0.2], End: [6, 0, -0.2], Width: 0.3, Height: 0.4 }));
let x = await t.exportModel('columns-before');
t.check('columns sit on their grid crossings', () => cols.every((c, i) => { const b = x.bbox(c); return b && P.near(b.centre[0], at[i][2], 2e-3) && P.near(b.centre[1], at[i][3], 2e-3) && P.near(b.max[2], 3.5, 2e-3); }) || `column boxes ${cols.map((c) => P.fmt(x.bbox(c)?.centre)).join(' ')}`);
t.step('raise ground floor-to-floor to 6 m', () => S.editStorey(M, { kind: 'floorHeight', storeyId: L1.expressId, Height: 6.0 }, S.planStoreyEdit(M, { kind: 'floorHeight', storeyId: L1.expressId, Height: 6.0 })));
x = await t.exportModel();
t.check('column tops follow the storey above', () => cols.every((c) => P.near(x.bbox(c)?.max[2], 6.0, 2e-3)) || `after Level 2 moved to 6 m the column tops are at ${cols.map((c) => P.fmt(x.bbox(c)?.max[2])).join(', ')} m (leaving a ${P.fmt(6 - (x.bbox(cols[0])?.max[2] ?? 0))} m void)`, { core: true });
t.check('beam moves with its level', () => P.near(x.bbox(beam)?.max[2], 6.0, 2e-3) || `beam top at ${P.fmt(x.bbox(beam)?.max[2])} m, expected 6`);
t.check('columns keep their grid crossings', () => cols.every((c, i) => { const b = x.bbox(c); return b && P.near(b.centre[0], at[i][2], 2e-3) && P.near(b.centre[1], at[i][3], 2e-3); }) || 'a column left its crossing');
t.done();
