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
const conc = t.step('concrete', () => S.addMaterial(M, { Name: 'Concrete C30/37', Category: 'concrete', Color: '#9a9a9a' }));
const steel = t.step('steel', () => S.addMaterial(M, { Name: 'Steel S355', Category: 'steel' }));
const slab = t.step('slab', () => S.addSlab(M, L1.expressId, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.25, Name: 'Slab' }));
const col = t.step('column', () => S.addColumn(M, L1.expressId, { Position: [1, 1, 0], Width: 0.3, Depth: 0.3, Height: 3, Name: 'Column' }));
t.step('assign concrete', () => S.assignMaterial(M, conc.expressId, [slab.expressId, col.expressId]));
t.check('materials read back in the live session', () => {
  const m = bim.materials(slab);
  return JSON.stringify(m ?? null).includes('Concrete') || `bim.materials() on the slab returns ${JSON.stringify(m)} in the session`;
});
t.step('reassign column', () => S.assignMaterial(M, steel.expressId, [col.expressId]));
const x = await t.exportModel();
t.check('assignments survive export, reassignment replaces', () => {
  const s = x.exportedId(slab), c = x.exportedId(col), cm = x.materialId('Concrete C30/37'), sm = x.materialId('Steel S355');
  const holds = (id, mat) => mat != null && x.relates('IFCRELASSOCIATESMATERIAL', id, mat);
  return (holds(s, cm) && holds(c, sm) && !holds(c, cm)) || `slab->concrete ${holds(s, cm)}, column->steel ${holds(c, sm)}, column still concrete ${holds(c, cm)}`;
}, { core: true });
t.check('a material carries its appearance', () => {
  // The colour is the material's own: follow Concrete's IfcMaterialDefinitionRepresentation ->
  // IfcStyledRepresentation -> IfcStyledItem -> IfcSurfaceStyle -> shading -> IfcColourRgb.
  const rec = (id) => (id ? x.content.match(new RegExp(`^#${id}=([A-Z0-9]+)\\((.*)\\);$`, 'm')) : null);
  const refs = (r) => [...(r?.[2] ?? '').matchAll(/#(\d+)/g)].map((m) => m[1]);
  const mat = x.materialId('Concrete C30/37');
  const mdr = x.content.match(new RegExp(`^#\\d+=IFCMATERIALDEFINITIONREPRESENTATION\\(\\$,\\$,\\(#(\\d+)\\),#${mat}\\);$`, 'm'));
  let r = rec(mdr?.[1]);
  r = rec(refs(r)[1]); // styled item
  r = rec(refs(r)[0]); // surface style (or IFC2X3 style assignment)
  if (r?.[1] === 'IFCPRESENTATIONSTYLEASSIGNMENT') r = rec(refs(r)[0]);
  r = rec(refs(r)[0]); // shading
  r = rec(refs(r)[0]); // colour
  const rgb = r?.[1] === 'IFCCOLOURRGB' ? r[2].split(',').slice(1).map(Number) : null;
  return (rgb && rgb.every((v) => P.near(v, 0x9a / 255, 1e-3))) || `Concrete C30/37 carries no #9a9a9a appearance of its own (${x.count('IFCMATERIALDEFINITIONREPRESENTATION')} material representations, resolved colour ${P.fmt(rgb)})`;
});
t.done();
