/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: layered-walls (#9296). Run by ./run.mjs through `ifc-lite run`.
// Oracle: a wall carries an ordered material layer set (IfcMaterialLayerSetUsage) that reads
// back and exports, and, like a Revit/Archicad wall type, the layers drive the wall's thickness.
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'layered-walls');
const S = bim.store, M = t.M, L1 = t.ground();
const layers = [['Brick', 0.115], ['Mineral wool', 0.1], ['Gypsum plaster', 0.015]];
const total = layers.reduce((a, [, d]) => a + d, 0);
const mats = layers.map(([Name]) => t.step(`material ${Name}`, () => S.addMaterial(M, { Name })));
const set = t.step('layer set', () => S.addMaterialLayerSet(M, { LayerSetName: 'Ext 230', MaterialLayers: layers.map(([, d], i) => ({ Material: mats[i]?.expressId, LayerThickness: d })) }));
const usage = t.step('layer set usage', () => S.addMaterialLayerSetUsage(M, { ForLayerSet: set.expressId, OffsetFromReferenceLine: -total / 2 }));
const wall = t.step('wall', () => S.addWall(M, L1.expressId, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: total, Height: 3, Name: 'Layered' }));
t.step('assign usage', () => S.assignMaterial(M, usage.expressId, [wall.expressId]));
t.check('layers read back in the live session', () => {
  const m = bim.materials(wall);
  const got = JSON.stringify(m);
  return layers.every(([n]) => got.includes(n)) && got.indexOf('Brick') < got.indexOf('Mineral') && got.indexOf('Mineral') < got.indexOf('Gypsum') || `bim.materials() on the authored wall returns ${got.slice(0, 200)} in the session (the layers only read back after export and reopen)`;
});
// A wall type carrying the layer set, then a thin wall typed with it.
const type = t.step('wall type', () => S.addElementType(M, { Type: 'IfcWallType', Name: 'Ext 230', PredefinedType: 'STANDARD' }));
t.step('type layers', () => S.assignMaterial(M, set.expressId, [type.expressId]));
const thin = t.step('wall to retype', () => S.addWall(M, L1.expressId, { Start: [0, 3, 0], End: [5, 3, 0], Thickness: 0.1, Height: 3, Name: 'Retyped' }));
t.step('assign type', () => S.assignType(M, type.expressId, [thin.expressId]));
const x = await t.exportModel();
t.check('layered wall exports its layer set usage', () => (x.count('IFCMATERIALLAYERSETUSAGE') >= 1 && x.count('IFCMATERIALLAYER') >= 3) || `exported ${x.count('IFCMATERIALLAYERSETUSAGE')} usages, ${x.count('IFCMATERIALLAYER')} layers`);
t.check('a layered wall type drives the wall thickness', () => {
  const b = x.bbox(thin);
  return (b && P.near(b.size[1], total, 2e-3)) || `typing a 0.1 m wall with the ${P.fmt(total)} m layered type leaves its body ${P.fmt(b?.size[1])} m thick`;
});
t.done();
