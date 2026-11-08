// Modelling parity SDK probe: grids (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle: a tagged 3 x 3 structural grid exports its axes, a column placed on a crossing
// lands on it, and moving the grid carries the columns bound to it (Revit "moves with grids").
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'grids');
const S = bim.store, M = t.M, L1 = t.ground();
const grid = t.step('add grid', () => S.addGrid(M, L1.expressId, {
  UAxes: [0, 5, 10].map((x, i) => ({ Tag: 'ABC'[i], Start: [x, -1], End: [x, 9] })),
  VAxes: [0, 4, 8].map((y, i) => ({ Tag: String(i + 1), Start: [-1, y], End: [11, y] })),
  Name: 'Grid',
}));
const axes = bim.query().byType('IfcGridAxis').toArray();
const tag = (a) => bim.attributes(a.ref).find((x) => x.name === 'AxisTag')?.value ?? a.name;
const axis = Object.fromEntries(axes.map((a) => [tag(a), a.ref.expressId]));
t.check('tagged grid axes', () => Object.keys(axis).sort().join(',') === '1,2,3,A,B,C' || `axis tags: ${Object.keys(axis).join(',') || 'none'}`);
const col = t.step('column on B2', () => S.addColumnOnGrid(M, L1.expressId, { Position: [5, 4, 0], Width: 0.4, Depth: 0.4, Height: 3 }, { GridId: grid.expressId, IntersectingAxes: [axis.B, axis['2']] }));
let x = await t.exportModel('grids-place');
t.check('grid exports with its axes', () => (x.count('IFCGRID') === 1 && x.count('IFCGRIDAXIS') === 6) || `exported ${x.count('IFCGRID')} IfcGrid, ${x.count('IFCGRIDAXIS')} IfcGridAxis`);
t.check('column on a crossing lands on it', () => {
  const b = x.bbox(col);
  return (b && P.near(b.centre[0], 5, 2e-3) && P.near(b.centre[1], 4, 2e-3) && x.count('IFCGRIDPLACEMENT') >= 1) || `column centre ${P.fmt(b?.centre)}, IfcGridPlacement ${x.count('IFCGRIDPLACEMENT')}`;
});
t.step('move grid 1 m east', () => S.transformElements(M, [grid.expressId], { kind: 'move', delta: [1, 0] }));
x = await t.exportModel();
t.check('moving the grid carries bound columns', () => {
  const b = x.bbox(col);
  return (b && P.near(b.centre[0], 6, 2e-3)) || `after moving the grid +1 m the column centre x is ${P.fmt(b?.centre[0])} (expected 6)`;
});
t.done();
