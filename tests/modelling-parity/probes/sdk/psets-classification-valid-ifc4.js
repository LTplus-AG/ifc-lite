/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modelling parity SDK probe: psets-classification-valid-ifc4 (#9296). Run by ./run.mjs.
// Oracle (Revit IFC export with property mapping + classification, Archicad Classification
// Manager, Bonsai ifcopenshell.api.classification): standard and custom psets with typed values
// read back and export as IFC4, and an element carries a Uniclass classification reference.
// Validity of the exported file is the output probe's job (tests/modelling-parity/output).
const P = await import(process.env.PARITY_LIB);
const t = P.probe(bim, 'psets-classification-valid-ifc4');
const S = bim.store, M = t.M, L1 = t.ground();
const wall = t.step('wall', () => S.addWall(M, L1.expressId, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.25, Height: 3, Name: 'Ext wall' }));
t.step('IsExternal', () => bim.mutate.setProperty(wall, 'Pset_WallCommon', 'IsExternal', true, 'IfcBoolean'));
t.step('FireRating', () => bim.mutate.setProperty(wall, 'Pset_WallCommon', 'FireRating', 'EI60', 'IfcLabel'));
t.step('U value', () => bim.mutate.setProperty(wall, 'Pset_WallCommon', 'ThermalTransmittance', 0.25, 'IfcThermalTransmittanceMeasure'));
t.step('custom', () => bim.mutate.setProperty(wall, 'Acme_Costing', 'UnitCost', 120.5, 'IfcReal'));
t.check('psets read back in the live session', () => (bim.property(wall, 'Pset_WallCommon', 'FireRating') === 'EI60' && bim.property(wall, 'Acme_Costing', 'UnitCost') === 120.5) || `read FireRating=${bim.property(wall, 'Pset_WallCommon', 'FireRating')}, UnitCost=${bim.property(wall, 'Acme_Costing', 'UnitCost')}`);
const classify = ['addClassification', 'assignClassification', 'addClassificationReference'].find((k) => typeof S[k] === 'function');
if (classify) t.step('classify', () => S[classify](M, { System: 'Uniclass 2015', Identification: 'EF_25_10', Name: 'Walls', objects: [wall.expressId] }));
const x = await t.exportModel();
t.check('typed psets export as IFC4', () => {
  const want = [/IFCPROPERTYSINGLEVALUE\('IsExternal',\$,IFCBOOLEAN\(\.T\.\)/, /IFCPROPERTYSINGLEVALUE\('FireRating',\$,IFCLABEL\('EI60'\)/, /IFCPROPERTYSINGLEVALUE\('ThermalTransmittance',\$,IFCTHERMALTRANSMITTANCEMEASURE\(0\.25\)/, /IFCPROPERTYSINGLEVALUE\('UnitCost',\$,IFCREAL\(120\.5\)/, /FILE_SCHEMA\(\('IFC4'\)\)/];
  const miss = want.filter((r) => !r.test(x.content));
  return miss.length === 0 || `missing in export: ${miss.map((r) => r.source.slice(0, 60)).join(' ; ')}`;
}, { core: true });
t.check('an element carries a classification reference', () => {
  if (!classify) return 'no SDK classification API (bim.store has no addClassification/assignClassification); only the raw addEntity escape hatch';
  return (x.count('IFCCLASSIFICATIONREFERENCE') >= 1 && x.count('IFCRELASSOCIATESCLASSIFICATION') >= 1) || 'no classification reference in export';
});
t.done();
