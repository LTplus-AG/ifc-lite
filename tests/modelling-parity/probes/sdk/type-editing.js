/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: type-editing (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle (Revit Edit Type, Archicad favourites/composites, Bonsai type manager): type data
// reaches every occurrence, editing the type updates them all at once, an occurrence can swap
// type, and a type's geometric parameter (wall thickness) drives its occurrences' geometry.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'type-editing');
const S = bim.store, M = t.M, L1 = t.ground();
const A = t.step('type A', () => S.addElementType(M, { Type: 'IfcWallType', Name: 'WT-200', PredefinedType: 'STANDARD' }));
const B = t.step('type B', () => S.addElementType(M, { Type: 'IfcWallType', Name: 'WT-300', PredefinedType: 'STANDARD' }));
// Each type's structure is its layer set (Revit Edit Type > Structure, an IFC wall type's IfcMaterialLayerSet).
const brick = t.step('brick', () => S.addMaterial(M, { Name: 'Brick' }));
for (const [type, depth] of [[A, 0.2], [B, 0.3]]) {
  t.step(`type ${depth} m structure`, () => S.assignMaterial(M, S.addMaterialLayerSet(M, { LayerSetName: `Brick ${depth * 1000}`, MaterialLayers: [{ Material: brick.expressId, LayerThickness: depth }] }).expressId, [type.expressId]));
}
const walls = [0, 2, 4].map((y, i) => t.step(`wall ${i}`, () => S.addWall(M, L1.expressId, { Start: [0, y, 0], End: [5, y, 0], Thickness: 0.2, Height: 3, Name: `W${i}` })));
t.step('assign type A', () => S.assignType(M, A.expressId, walls.map((w) => w.expressId)));
t.step('type property', () => bim.mutate.setProperty(A, 'Pset_WallCommon', 'FireRating', 'EI60', 'IfcLabel'));
const rating = (w) => JSON.stringify(bim.typeProperties(w) ?? null).match(/"FireRating"[^}]*?"value":"?([A-Z0-9]+)/)?.[1] ?? null;
t.check('type data reads back on every occurrence in the live session', () => walls.every((w) => rating(w) === 'EI60') || `bim.typeProperties() on the occurrences returns FireRating ${walls.map((w) => rating(w) ?? 'nothing').join(', ')} in the session (it reads back only after export and reopen)`);
t.step('edit type property', () => bim.mutate.setProperty(A, 'Pset_WallCommon', 'FireRating', 'EI90', 'IfcLabel'));
let x = await t.exportModel('type-editing-props');
t.check('editing the type updates all occurrences', () => {
  // Judged on the file: the one type pset carries the edit and every occurrence is defined by that type.
  const psetOnType = /IFCPROPERTYSINGLEVALUE\('FireRating',\$,IFCLABEL\('EI90'\)/.test(x.content) && !/'EI60'/.test(x.content);
  const typed = walls.every((w) => x.relates('IFCRELDEFINESBYTYPE', x.exportedId(w), x.exportedId(A)));
  return (psetOnType && typed) || `edited type pset in export: ${psetOnType}; all occurrences defined by the type: ${typed}`;
}, { core: true });
t.step('swap W2 to type B', () => S.assignType(M, B.expressId, [walls[2].expressId]));
x = await t.exportModel();
t.check('an occurrence swaps type', () => {
  const w2 = x.exportedId(walls[2]), onB = x.relates('IFCRELDEFINESBYTYPE', w2, x.exportedId(B)), onA = x.relates('IFCRELDEFINESBYTYPE', w2, x.exportedId(A));
  return (onB && !onA) || `W2 typed by WT-300: ${onB}, still typed by WT-200: ${onA}`;
});
t.check('a type parameter drives occurrence geometry', () => {
  // Revit: Edit Type > Structure > thickness 0.3 resizes every WT-300 wall. Here the type's
  // structure is its 0.3 m layer set: retyping W2 to WT-300 must bring its body to 0.3 m.
  const b = x.bbox(walls[2]);
  return (b && P.near(b.size[1], 0.3, 2e-3)) || `a wall retyped to WT-300 (a 0.3 m layer set) keeps its own ${P.fmt(b?.size[1])} m body`;
});
t.done();
