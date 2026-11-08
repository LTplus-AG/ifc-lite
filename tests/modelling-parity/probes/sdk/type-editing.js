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
  const rels = x.content.match(/IFCRELDEFINESBYTYPE\([^;]*;/g) ?? [];
  const typed = walls.every((w) => rels.some((r) => new RegExp(`#${x.exportedId(w)}[,)]`).test(r) && r.includes(`#${x.exportedId(A)})`)));
  return (psetOnType && typed) || `edited type pset in export: ${psetOnType}; all occurrences defined by the type: ${typed}`;
}, { core: true });
t.step('swap W2 to type B', () => S.assignType(M, B.expressId, [walls[2].expressId]));
x = await t.exportModel();
t.check('an occurrence swaps type', () => {
  const rels = x.content.match(/IFCRELDEFINESBYTYPE\([^;]*;/g) ?? [];
  const w2 = `#${x.exportedId(walls[2])}`, a = `#${x.exportedId(A)}`, b = `#${x.exportedId(B)}`;
  const on = (r, id) => new RegExp(`${id}[,)]`).test(r);
  return (rels.some((r) => on(r, w2) && r.includes(b)) && !rels.some((r) => on(r, w2) && r.includes(a))) || `W2 type relations: ${rels.filter((r) => on(r, w2)).length}`;
});
t.check('a type parameter drives occurrence geometry', () => {
  // Revit: Edit Type > Structure > thickness 0.3 resizes every WT-300 wall. The SDK has no type-level
  // geometric parameter; the closest record is the type's layer set, which layered-walls probes.
  const b = x.bbox(walls[2]);
  return (b && P.near(b.size[1], 0.3, 2e-3)) || `a wall retyped to WT-300 keeps its own ${P.fmt(b?.size[1])} m body; no type-level thickness parameter exists`;
});
t.done();
