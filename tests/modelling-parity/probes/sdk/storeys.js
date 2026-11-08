// Modelling parity SDK probe: storeys (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle: storeys at typed elevations, rename, floor-to-floor edit shifts the storeys above
// and attached walls follow, Archicad-style insert re-binds walls attached to the next
// storey, delete moves contents. Geometry is read back from the exported, meshed IFC.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'storeys');
const S = bim.store, M = t.M;
const L1 = t.ground();
const L2 = t.step('add Level 2', () => S.addStorey(M, { Name: 'Level 2', Elevation: 3.0, referenceStoreyId: L1.expressId }));
const RF = t.step('add Roof', () => S.addStorey(M, { Name: 'Roof', Elevation: 6.0 }));
const elevations = () => t.levels().map((s) => `${s.Name}@${P.fmt(s.elevation)}`).join(', ');

t.check('storeys at typed elevations', () => elevations() === 'Level 1@0, Level 2@3, Roof@6' || elevations());
t.check('rename a storey', () => {
  S.renameStorey({ modelId: M, expressId: L2.expressId }, 'First floor');
  return t.levels()[1].Name === 'First floor' || `names: ${elevations()}`;
});

// A wall attached to the storey above (the Model workspace's record) follows a floor-to-floor edit.
const wall = t.step('attached wall', () => S.addWall(M, L1.expressId, { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 3.0, Name: 'Attached' }));
const fixed = t.step('fixed wall', () => S.addWall(M, L1.expressId, { Start: [0, 2, 0], End: [6, 2, 0], Thickness: 0.2, Height: 2.5, Name: 'Fixed' }));
t.step('attach wall top', () => bim.mutate.setProperty(wall, 'IfcLite_StoreyAttachment', 'TopConstraint', t.globalId(L2), 'IfcLabel'));
const plan = t.step('plan floor-to-floor', () => S.planStoreyEdit(M, { kind: 'floorHeight', storeyId: L1.expressId, Height: 3.3 }));
t.step('apply floor-to-floor', () => S.editStorey(M, { kind: 'floorHeight', storeyId: L1.expressId, Height: 3.3 }, plan));
let x = await t.exportModel('storeys-f2f');
t.check('floor-to-floor shifts storeys above', () => elevations() === 'Level 1@0, First floor@3.3, Roof@6.3' || elevations());
t.check('attached wall follows the storey above', () => {
  const b = x.bbox(wall);
  return (b && P.near(b.max[2], 3.3, 2e-3)) || `attached wall top at ${P.fmt(b?.max[2])} m, expected 3.3`;
});
t.check('fixed wall keeps its height', () => {
  const b = x.bbox(fixed);
  return (b && P.near(b.max[2], 2.5, 2e-3)) || `fixed wall top at ${P.fmt(b?.max[2])} m, expected 2.5`;
});

// Archicad "Insert storey above": storeys above move up and the wall attached to the next
// storey re-binds to the inserted one. Composed here from the SDK's own steps.
t.step('push storeys above', () => S.editStorey(M, { kind: 'floorHeight', storeyId: L1.expressId, Height: 6.3 }));
const mid = t.step('insert storey', () => S.addStorey(M, { Name: 'Mezzanine', Elevation: 3.3, referenceStoreyId: L1.expressId }));
x = await t.exportModel('storeys-insert');
t.check('inserted storey re-binds walls attached to the storey above', () => {
  const b = x.bbox(wall);
  return (mid && b && P.near(b.max[2], 3.3, 2e-3)) || `after inserting a storey at 3.3 m the attached wall top is at ${P.fmt(b?.max[2])} m (still bound to the storey now at 6.3 m)`;
});

// Delete a storey that holds elements, moving them to another storey.
const slab = t.step('slab on Roof', () => S.addSlab(M, RF.expressId, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.2, Name: 'Roof slab' }));
t.check('delete a storey, moving its contents', () => {
  const ref = { modelId: M, expressId: RF.expressId };
  const mode = { kind: 'move', targetStoreyId: L2.expressId };
  S.deleteStorey(ref, mode, S.planStoreyDelete(ref, mode));
  const host = bim.storey({ modelId: M, expressId: slab.expressId });
  return (!t.levels().some((s) => s.Name === 'Roof') && host?.ref.expressId === L2.expressId) || `storeys ${elevations()}, slab on ${host?.name}`;
});
await t.exportModel();
t.done();
