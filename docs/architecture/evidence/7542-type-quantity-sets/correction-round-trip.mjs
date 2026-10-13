/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// node correction-round-trip.mjs <ids dist> [<ids dist> ...]
// #7542: an IDS correction made the way the viewer makes it, exported, and parsed again.
//
// Per scenario and build, the steps of IDSCorrectionDialog.tsx:
//   1. the value before, read through createDataAccessor;
//   2. the raw value: propertyValueToRaw with dataType = the existing entry's dataType, or the
//      facet's (scaleCorrectionForWrite);
//   3. the write: MutablePropertyView.setProperty(id, pset, prop, raw, Real, undefined, false,
//      dataType), as mutationSlice.ts calls it, on a view configured as configureMutationView.ts
//      configures it (type objects read through extractTypeEntityOwnProperties);
//   4. what the view then holds for that set (MutablePropertyView.getForEntity), each item as
//      name=value and its unit when it has one;
//   5. the session: createDataAccessor with the overlay projected from the view, as
//      property-overlay-snapshot.ts projects it, and checkPropertyFacet on it;
//   6. StepExporter's lines for the corrected value and its set;
//   7. the export parsed again (IfcParser.parseColumnar) and read through the same build.
// The models are generated below; nothing is read from disk. @ifc-lite/parser, data, mutations
// and export are this checkout's dists, shared by every build.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const pkg = (p) => new URL(`../../../../packages/${p}`, import.meta.url).href;
const parser = await import(pkg('parser/dist/index.js'));
const { PropertyValueType } = await import(pkg('data/dist/index.js'));
const { MutablePropertyView } = await import(pkg('mutations/dist/index.js'));
const { StepExporter } = await import(pkg('export/dist/index.js'));
const builds = await Promise.all(process.argv.slice(2).map(async (d) => ({
  name: d.split(/[\\/]/).pop(),
  ...(await import(pathToFileURL(resolve(d, 'index.js')).href)),
  ...(await import(pathToFileURL(resolve(d, 'bridge/index.js')).href)),
})));

const W1 = 20, W2 = 21, W3 = 22, W4 = 23, WT = 50;
const gid = (p, id) => p + String(id).padStart(22 - p.length, '0');
function model({ lengthUnit = '$,.METRE.', typeLengthUnit = '#4' } = {}) {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('round-trip.ifc','2026-10-13T00:00:00',(''),(''),'','','');
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
#${WT}=IFCWALLTYPE('${gid('0type', WT)}',$,'WT',$,$,(#51,#53),$,$,$,.STANDARD.);
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
ENDSEC;
END-ISO-10303-21;`;
}

const SCENARIOS = [
  ['A. inherited quantity with its own millimetre Unit, metre project: W1 Qto_WallBaseQuantities.Length to 6',
    {}, W1, 'Qto_WallBaseQuantities', 'Length', 6],
  ['B. inherited property with its own millimetre Unit, metre project: W1 Pset_TypeOwnUnit.Width to 0.3',
    {}, W1, 'Pset_TypeOwnUnit', 'Width', 0.3],
  ['C. inherited quantity, no own Unit, millimetre project: W1 Qto_WallBaseQuantities.Length to 6',
    { lengthUnit: '.MILLI.,.METRE.', typeLengthUnit: '$' }, W1, 'Qto_WallBaseQuantities', 'Length', 6],
  ['D. as A, on W2, which holds its own Qto_WallBaseQuantities (Width 0.2): Length to 6',
    {}, W2, 'Qto_WallBaseQuantities', 'Length', 6],
  ['E. the type object checked directly, its own quantity with its own millimetre Unit: WT Length to 6',
    {}, WT, 'Qto_WallBaseQuantities', 'Length', 6],
  ['F. control: W3\'s own property with its own millimetre Unit (#7395): W3 Pset_Own.Span to 6',
    {}, W3, 'Pset_Own', 'Span', 6],
  ['G. control: the type object checked directly, its own property with its own millimetre Unit: WT Width to 0.3',
    {}, WT, 'Pset_TypeOwnUnit', 'Width', 0.3],
  ['H. W4\'s own quantity with its own millimetre Unit, metre project, W4 not typed: Qto_WallBaseQuantities.Height to 4',
    {}, W4, 'Qto_WallBaseQuantities', 'Height', 4],
];

const parse = (text) => {
  const bytes = new TextEncoder().encode(text);
  return new parser.IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
// configureMutationView.ts
function viewFor(store) {
  const view = new MutablePropertyView(store.properties || null, 'm');
  view.setOnDemandExtractor((id) => parser.getInheritanceChainAcrossSchemas(store.entities?.getTypeName(id) ?? '').includes('IfcTypeObject')
    ? parser.extractTypeEntityOwnProperties(store, id)
    : parser.extractPropertiesOnDemand(store, id));
  if (store.onDemandQuantityMap) view.setQuantityExtractor((id) => parser.extractQuantitiesOnDemand(store, id, view));
  return view;
}
// property-overlay-snapshot.ts, overridesForEntity
function overlayOf(view) {
  const byEntity = new Map();
  for (const m of view.getMutations()) {
    if (!m.psetName || !m.propName) continue;
    const live = view.getPropertyMutation(m.entityId, m.psetName, m.propName);
    if (!live) continue;
    const list = byEntity.get(m.entityId) ?? [];
    if (list.some((o) => o.psetName === m.psetName && o.propName === m.propName)) continue;
    list.push(live.operation === 'DELETE'
      ? { psetName: m.psetName, propName: m.propName, value: null, deleted: true }
      : { psetName: m.psetName, propName: m.propName, value: live.value ?? null, dataType: live.dataType });
    byEntity.set(m.entityId, list);
  }
  return (id) => byEntity.get(id);
}
const facet = (pset, prop, value) => ({
  type: 'property', propertySet: { type: 'simpleValue', value: pset }, baseName: { type: 'simpleValue', value: prop },
  dataType: { type: 'simpleValue', value: 'IFCLENGTHMEASURE' }, value: { type: 'simpleValue', value: String(value) },
});
const fmt = (v) => (typeof v === 'number' ? String(Number(v.toPrecision(12))) : String(v));
const sets = (a, id, pset) => a.getPropertySets(id).filter((s) => s.name === pset)
  .map((s) => `{${s.properties.map((p) => `${p.name}=${fmt(p.value)}`).join(',')}}`).join(' ') || '(none)';
// What the view holds for the set after the write: a set it created ("new") or one of the
// entity's own sets it edited ("edited"), each item with its unit when it has one.
const viewSets = (view, id, pset) => view.getForEntity(id).filter((s) => s.name === pset)
  .map((s) => `${String(s.globalId).startsWith('new_') ? 'new' : 'edited'} {${s.properties
    .map((p) => `${p.name}=${fmt(p.value)}${p.unit ? ` unit ${p.unit}` : ''}`).join(',')}}`).join(' ') || '(none)';
const verdict = (B, a, id, pset, prop, target) => {
  const r = B.checkPropertyFacet(facet(pset, prop, target), id, a);
  return r.passed ? 'pass' : `fail ${r.failure?.type}`;
};

for (const [label, opts, id, pset, prop, target] of SCENARIOS) {
  console.log(label);
  for (const B of builds) {
    const store = await parse(model(opts));
    const view = viewFor(store);
    const before = B.createDataAccessor(store, overlayOf(view));
    const existing = before.getPropertyValue(id, pset, prop);
    const dataType = existing?.dataType || 'IFCLENGTHMEASURE';
    const raw = B.propertyValueToRaw(store, id, pset, prop, dataType, target);
    view.setProperty(id, pset, prop, raw, PropertyValueType.Real, undefined, false, dataType);
    const session = B.createDataAccessor(store, overlayOf(view));
    const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4' }).content);
    // Every line that holds `prop`, the sets that list one, and what attaches those sets.
    const lines = text.split(/\r?\n/);
    const idOf = (l) => l.match(/^#(\d+)=/)?.[1];
    const refers = (l, ids) => [...ids].some((s) => new RegExp(`[(,]#${s}[,)]`).test(l));
    const valueLines = lines.filter((l) => l.includes(`('${prop}',`));
    const setLines = lines.filter((l) => /=IFC(PROPERTYSET|ELEMENTQUANTITY)\(/.test(l) && refers(l, new Set(valueLines.map(idOf))));
    const ownerLines = lines.filter((l) => /=IFC(RELDEFINESBYPROPERTIES|WALLTYPE)\(/.test(l) && refers(l, new Set(setLines.map(idOf))));
    const reparsed = await parse(text);
    const after = B.createDataAccessor(reparsed);
    console.log(`  ${B.name}:`);
    console.log(`    before: ${pset} ${sets(before, id, pset)}; ${verdict(B, before, id, pset, prop, target)}`);
    console.log(`    propertyValueToRaw(${fmt(target)}, ${dataType}) = ${fmt(raw)}`);
    console.log(`    view: ${pset} ${viewSets(view, id, pset)}`);
    console.log(`    session: ${pset} ${sets(session, id, pset)}; ${verdict(B, session, id, pset, prop, target)}`);
    for (const l of [...valueLines, ...setLines, ...ownerLines]) console.log(`    exported: ${l}`);
    console.log(`    parsed again: ${pset} ${sets(after, id, pset)}; ${verdict(B, after, id, pset, prop, target)}`);
  }
}
