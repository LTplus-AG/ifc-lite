/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: materials (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle (Revit/Archicad materials and surfaces, Bonsai IfcMaterial): materials are assigned
// to elements, read back, survive export, can be reassigned, and carry an appearance colour
// (IfcMaterialDefinitionRepresentation) so elements render in their material's colour.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'materials');
const S = bim.store, M = t.M, L1 = t.ground();
const conc = t.step('concrete', () => S.addMaterial(M, { Name: 'Concrete C30/37', Category: 'concrete' }));
const steel = t.step('steel', () => S.addMaterial(M, { Name: 'Steel S355', Category: 'steel' }));
const slab = t.step('slab', () => S.addSlab(M, L1.expressId, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.25, Name: 'Slab' }));
const col = t.step('column', () => S.addColumn(M, L1.expressId, { Position: [1, 1, 0], Width: 0.3, Depth: 0.3, Height: 3, Name: 'Column' }));
t.step('assign concrete', () => S.assignMaterial(M, conc.expressId, [slab.expressId, col.expressId]));
t.check('materials read back in the live session', () => {
  const m = bim.materials(slab);
  return JSON.stringify(m ?? null).includes('Concrete') || `bim.materials() on the slab returns ${JSON.stringify(m)} in the session`;
});
t.step('reassign column', () => S.assignMaterial(M, steel.expressId, [col.expressId]));
t.step('appearance', () => bim.style.apply([slab], '#9a9a9a', { name: 'Concrete C30/37' }));
const x = await t.exportModel();
t.check('assignments survive export, reassignment replaces', () => {
  const rels = x.content.match(/IFCRELASSOCIATESMATERIAL\([^;]*;/g) ?? [];
  // IfcMaterial has no GlobalId: find it by name in the export.
  const byName = (n) => `#${x.content.match(new RegExp(`#(\\d+)=IFCMATERIAL\\('${n}'`))?.[1]}`;
  const s = `#${x.exportedId(slab)}`, c = `#${x.exportedId(col)}`, cm = byName('Concrete C30/37'), sm = byName('Steel S355');
  const holds = (id, mat) => rels.some((r) => new RegExp(`${id}[,)]`).test(r) && r.includes(`${mat})`));
  return (holds(s, cm) && holds(c, sm) && !holds(c, cm)) || `slab->concrete ${holds(s, cm)}, column->steel ${holds(c, sm)}, column still concrete ${holds(c, cm)}`;
}, { core: true });
t.check('a material carries its appearance', () => x.count('IFCMATERIALDEFINITIONREPRESENTATION') >= 1 || `no IfcMaterialDefinitionRepresentation: colour is per element (bim.style), not a property of the material`);
t.done();
