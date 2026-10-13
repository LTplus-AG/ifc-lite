/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node correction-paths.mjs <ids dist> [<ids dist> ...]
// #7542: each correction claim in the changeset, run on each build through the public bridge
// functions: propertyValueToRaw, and createDataAccessor with a propertyOverlay. No export here
// (correction-round-trip.mjs exports). Each line prints the sets of that name on the entity,
// every item as name=value:dataType, or propertyValueToRaw's result.
// Model: W1 typed by WT, no sets of its own; W2 typed by WT, its own Qto_WallBaseQuantities
// holding Width 0.2 only; W3 its own Pset_Own.Span 5000 with a millimetre Unit; W4, not typed,
// its own Qto_WallBaseQuantities.Height 3000 with a millimetre Unit. WT holds
// Qto_WallBaseQuantities.Length 5000 and Pset_TypeOwnUnit.Width 200 (millimetre Unit).
// The project unit and the Unit of the type's Length vary per case. Generated below.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { IfcParser } = await import(new URL('../../../../packages/parser/dist/index.js', import.meta.url).href);
const builds = await Promise.all(process.argv.slice(2).map(async (d) => ({
  name: d.split(/[\\/]/).pop(),
  ...(await import(pathToFileURL(resolve(d, 'bridge/index.js')).href)),
})));

const W1 = 20, W2 = 21, W3 = 22, W4 = 23, WT = 50;
const gid = (p, id) => p + String(id).padStart(22 - p.length, '0');
function model({ project = 'metre', typeLengthUnit = '$', viaRel = false }) {
  const lengthUnit = project === 'metre' ? '$,.METRE.' : '.MILLI.,.METRE.';
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('paths.ifc','2026-10-13T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${gid('0proj', 1)}',$,'P',$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,${lengthUnit});
#3=IFCUNITASSIGNMENT((#2));
#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#${W1}=IFCWALL('${gid('0wall', W1)}',$,'W1',$,$,$,$,$,$);
#${W2}=IFCWALL('${gid('0wall', W2)}',$,'W2',$,$,$,$,$,$);
#${W3}=IFCWALL('${gid('0wall', W3)}',$,'W3',$,$,$,$,$,$);
#${W4}=IFCWALL('${gid('0wall', W4)}',$,'W4',$,$,$,$,$,$);
#${WT}=IFCWALLTYPE('${gid('0type', WT)}',$,'WT',$,$,(${viaRel ? '#53' : '#51,#53'}),$,$,$,.STANDARD.);
#51=IFCELEMENTQUANTITY('${gid('0qto', 51)}',$,'Qto_WallBaseQuantities',$,$,(#52));
#52=IFCQUANTITYLENGTH('Length',$,${typeLengthUnit},5000.,$);
#53=IFCPROPERTYSET('${gid('0pset', 53)}',$,'Pset_TypeOwnUnit',$,(#54));
#54=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(200.),#4);
#55=IFCRELDEFINESBYTYPE('${gid('0rdbt', 55)}',$,$,$,(#${W1},#${W2},#${W3}),#${WT});
#60=IFCELEMENTQUANTITY('${gid('0qto', 60)}',$,'Qto_WallBaseQuantities',$,$,(#61));
#61=IFCQUANTITYLENGTH('Width',$,$,0.2,$);
#62=IFCRELDEFINESBYPROPERTIES('${gid('0rdbp', 62)}',$,$,$,(#${W2}),#60);
#70=IFCPROPERTYSET('${gid('0pset', 70)}',$,'Pset_Own',$,(#71));
#71=IFCPROPERTYSINGLEVALUE('Span',$,IFCLENGTHMEASURE(5000.),#4);
#72=IFCRELDEFINESBYPROPERTIES('${gid('0rdbp', 72)}',$,$,$,(#${W3}),#70);
#80=IFCELEMENTQUANTITY('${gid('0qto', 80)}',$,'Qto_WallBaseQuantities',$,$,(#81));
#81=IFCQUANTITYLENGTH('Height',$,#4,3000.,$);
#82=IFCRELDEFINESBYPROPERTIES('${gid('0rdbp', 82)}',$,$,$,(#${W4}),#80);
${viaRel ? `#63=IFCRELDEFINESBYPROPERTIES('${gid('0rdbp', 63)}',$,$,$,(#${WT}),#51);` : ''}
ENDSEC;
END-ISO-10303-21;`;
}
const parse = (opts) => {
  const bytes = new TextEncoder().encode(model(opts));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const fmt = (v) => (typeof v === 'number' ? String(Number(v.toPrecision(12))) : String(v));
const sets = (B, store, id, pset, overrides) => {
  const a = B.createDataAccessor(store, overrides ? (e) => (e === id ? overrides : undefined) : undefined);
  return a.getPropertySets(id).filter((s) => s.name === pset)
    .map((s) => `{${s.properties.map((p) => `${p.name}=${fmt(p.value)}${p.dataType ? `:${p.dataType}` : ''}`).join(', ')}}`).join(' ') || '(none)';
};
const toRaw = (id, pset, prop, dataType, value) => (B, store) => fmt(B.propertyValueToRaw(store, id, pset, prop, dataType, value));
const read = (id, pset, overrides) => (B, store) => sets(B, store, id, pset, overrides);
const L = 'IFCLENGTHMEASURE', Q = 'Qto_WallBaseQuantities', P = 'Pset_TypeOwnUnit';
const ov = (pset, prop, value, dataType) => ({ psetName: pset, propName: prop, value, ...(dataType ? { dataType } : {}) });

const CASES = [
  ['Reading. W1 sets, metre project, the type\'s quantity set attached through IfcRelDefinesByProperties only',
    { viaRel: true }, read(W1, Q)],
  ['Override of an inherited quantity, W1 has no set of that name, millimetre project: Length raw 7000, no dataType',
    { project: 'mm' }, read(W1, Q, [ov(Q, 'Length', 7000)])],
  ['  the same with dataType IFCLENGTHMEASURE',
    { project: 'mm' }, read(W1, Q, [ov(Q, 'Length', 7000, L)])],
  ['Override of an inherited quantity, W2 holds its own set of that name (Width only), millimetre project: Length raw 7000, no dataType',
    { project: 'mm' }, read(W2, Q, [ov(Q, 'Length', 7000)])],
  ['  the same with dataType IFCLENGTHMEASURE',
    { project: 'mm' }, read(W2, Q, [ov(Q, 'Length', 7000, L)])],
  ['Override deleting an inherited quantity, W1 has no set of that name, metre project: Length',
    {}, read(W1, Q, [{ psetName: Q, propName: 'Length', value: null, deleted: true }])],
  ['propertyValueToRaw, inherited quantity, millimetre project, no own Unit: 5, no dataType',
    { project: 'mm' }, toRaw(W1, Q, 'Length', undefined, 5)],
  ['  the same with dataType IFCLENGTHMEASURE',
    { project: 'mm' }, toRaw(W1, Q, 'Length', L, 5)],
  ['propertyValueToRaw, inherited quantity with its own millimetre Unit, metre project: 6, IFCLENGTHMEASURE',
    { typeLengthUnit: '#4' }, toRaw(W1, Q, 'Length', L, 6)],
  ['Override of an inherited quantity with its own millimetre Unit, metre project: Length raw 6',
    { typeLengthUnit: '#4' }, read(W1, Q, [ov(Q, 'Length', 6)])],
  ['propertyValueToRaw, inherited property with its own millimetre Unit, metre project: 0.3, IFCLENGTHMEASURE',
    {}, toRaw(W1, P, 'Width', L, 0.3)],
  ['  the same, no dataType',
    {}, toRaw(W1, P, 'Width', undefined, 0.3)],
  ['Override of an inherited property with its own millimetre Unit, metre project: Width raw 0.3',
    {}, read(W1, P, [ov(P, 'Width', 0.3)])],
  ['Two overrides of that property in one array: raw 0.2, then raw 0.3',
    {}, read(W1, P, [ov(P, 'Width', 0.2), ov(P, 'Width', 0.3)])],
  ['propertyValueToRaw, the type object checked directly, its quantity with its own millimetre Unit, metre project: 6, IFCLENGTHMEASURE',
    { typeLengthUnit: '#4' }, toRaw(WT, Q, 'Length', L, 6)],
  ['Override on the type object checked directly, that quantity: Length raw 6',
    { typeLengthUnit: '#4' }, read(WT, Q, [ov(Q, 'Length', 6, L)])],
  ['propertyValueToRaw, the type object checked directly, its quantity, millimetre project, no own Unit: 6, no dataType',
    { project: 'mm' }, toRaw(WT, Q, 'Length', undefined, 6)],
  ['propertyValueToRaw, W4\'s own quantity with its own millimetre Unit, metre project: 4, IFCLENGTHMEASURE',
    {}, toRaw(W4, Q, 'Height', L, 4)],
  ['Override of that quantity: Height raw 4',
    {}, read(W4, Q, [ov(Q, 'Height', 4, L)])],
  ['Control: propertyValueToRaw, W3\'s own property with its own millimetre Unit, metre project: 6, IFCLENGTHMEASURE',
    {}, toRaw(W3, 'Pset_Own', 'Span', L, 6)],
  ['Control: override of that property, Span raw 6000',
    {}, read(W3, 'Pset_Own', [ov('Pset_Own', 'Span', 6000)])],
  ['Control: propertyValueToRaw, the type object checked directly, its own property with its own millimetre Unit: 0.3, IFCLENGTHMEASURE',
    {}, toRaw(WT, P, 'Width', L, 0.3)],
  ['Control: override on the type object checked directly, that property: Width raw 300',
    {}, read(WT, P, [ov(P, 'Width', 300)])],
];

for (const [label, opts, run] of CASES) {
  console.log(label);
  for (const B of builds) {
    const store = await parse(opts);
    let out;
    try { out = run(B, store); } catch (e) { out = `throws ${e?.name}: ${e?.message}`; }
    console.log(`  ${B.name.padEnd(10)} ${out}`);
  }
}
