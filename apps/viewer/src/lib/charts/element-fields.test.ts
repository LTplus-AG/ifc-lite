/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, extractPropertiesOnDemand, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { QuantityType } from '@ifc-lite/data';
import type { ElementFieldBinding } from '@ifc-lite/charts';
import { createElementFieldReader } from './element-field-reader.js';
import { configureMutationView } from '@/utils/configureMutationView.js';

const FIRE: ElementFieldBinding = { kind: 'property', psetName: 'Pset_SlabCommon', propertyName: 'FireRating', valueKind: 'category' };
const SPREAD: ElementFieldBinding = { kind: 'property', psetName: 'Pset_SlabCommon', propertyName: 'SurfaceSpreadOfFlame', valueKind: 'category' };
/** A binding as read back from an unvalidated saved dashboard, where the type's guarantees do not hold. */
const persisted = (json: string): ElementFieldBinding => JSON.parse(json) as ElementFieldBinding;
const SAMPLE = new URL('../../../public/samples/building-architecture.ifc', import.meta.url);
/** The committed sample may be checked out with CRLF line endings. */
const FILE_END = /ENDSEC;\r?\nEND-ISO-10303-21;/;

async function parseText(source: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function parseSampleWith(extra: string, patch: (source: string) => string = (source) => source): Promise<IfcDataStore> {
  const fixture = await readFile(SAMPLE, 'utf8');
  assert.match(fixture, FILE_END);
  return parseText(patch(fixture).replace(FILE_END, `${extra}\nENDSEC;\nEND-ISO-10303-21;`));
}

describe('chart IFC field reader (#4833)', () => {
  it('uses occurrence precedence and type-only fallback on the committed authoring fixture', async () => {
    const bytes = await readFile(SAMPLE);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const reader = createElementFieldReader(store);

    assert.equal(reader.read(52, FIRE), 'REI30', 'occurrence FireRating wins over the type REI60');
    assert.equal(reader.read(52, SPREAD), 'A2 s1 d0', 'a missing occurrence property falls back to the defining type');
    const catalog = reader.discover([52]);
    assert.ok(catalog.properties.get('Pset_SlabCommon')?.some(({ binding }) => binding.kind === 'property' && binding.propertyName === 'SurfaceSpreadOfFlame'));
  });

  it('keeps explicit null and deletion missing instead of resurrecting the type value', async () => {
    const bytes = await readFile(SAMPLE);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const view = new MutablePropertyView(store.properties, 'fixture');
    configureMutationView(view, store);
    view.setProperty(52, 'Pset_SlabCommon', 'FireRating', null);
    assert.equal(createElementFieldReader(store, view).read(52, FIRE), null);
    view.deleteProperty(52, 'Pset_SlabCommon', 'FireRating');
    assert.equal(createElementFieldReader(store, view).read(52, FIRE), null);
  });

  it('applies defining-type edits and deletions before inherited fallback', async () => {
    const bytes = await readFile(SAMPLE);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const view = new MutablePropertyView(store.properties, 'fixture');
    view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
    view.setProperty(50, 'Pset_SlabCommon', 'SurfaceSpreadOfFlame', 'UPDATED');
    view.setProperty(50, 'AddedTypePset', 'NewField', 'NEW');
    const updatedReader = createElementFieldReader(store, view);
    assert.equal(updatedReader.read(52, SPREAD), 'UPDATED');
    assert.ok(updatedReader.discover([52]).properties.get('AddedTypePset')?.some(({ binding }) => binding.kind === 'property' && binding.propertyName === 'NewField'));
    const deleted = new MutablePropertyView(store.properties, 'fixture');
    configureMutationView(deleted, store);
    deleted.deleteProperty(50, 'Pset_SlabCommon', 'SurfaceSpreadOfFlame');
    assert.equal(createElementFieldReader(store, deleted).read(52, SPREAD), null);
  });

  it('does not restore an occurrence fallback after its defining type property set is deleted', async () => {
    const bytes = await readFile(SAMPLE);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const view = new MutablePropertyView(store.properties, 'fixture');
    configureMutationView(view, store);
    assert.equal(createElementFieldReader(store, view).read(52, SPREAD), 'A2 s1 d0', 'the occurrence reads its type property before deletion');

    view.deletePropertySet(50, 'Pset_SlabCommon');
    assert.equal(createElementFieldReader(store, view).read(52, SPREAD), null, 'the deleted type set cannot be merged back into the fallback');
  });

  it('preserves explicit units with their scale and never sums an incompatible measure', async () => {
    const store = await parseSampleWith(`
#60001=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#60002=IFCPROPERTYSINGLEVALUE('ExplicitLength',$,IFCLENGTHMEASURE(1.),#60001);
#60004=IFCPROPERTYSINGLEVALUE('MixedMeasure',$,IFCLENGTHMEASURE(1.),$);
#60005=IFCPROPERTYSINGLEVALUE('MixedMeasure',$,IFCAREAMEASURE(2.),$);
#60006=IFCPROPERTYSET('g-explicit',#1,'Probe',$,(#60002,#60004));
#60007=IFCPROPERTYSET('g-area',#1,'Probe',$,(#60005));
#60008=IFCRELDEFINESBYPROPERTIES('g-rel',#1,$,$,(#52),#60006);
#60009=IFCRELDEFINESBYPROPERTIES('g-area-rel',#1,$,$,(#395),#60007);`);
    const reader = createElementFieldReader(store);
    const length: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'ExplicitLength', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' };
    assert.deepEqual(reader.readResolved(52, length), { value: 1, status: 'value', unit: 'm', unitSiScale: 1, dataType: 'IFCLENGTHMEASURE' });
    const overlay = new MutablePropertyView(store.properties, 'fixture');
    overlay.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
    assert.deepEqual(createElementFieldReader(store, overlay).readResolved(52, length), { value: 1, status: 'value', unit: 'm', unitSiScale: 1, dataType: 'IFCLENGTHMEASURE' });
    const mixed = reader.discover([52, 395]).properties.get('Probe')?.find(({ binding }) => binding.kind === 'property' && binding.propertyName === 'MixedMeasure');
    assert.equal(mixed?.binding.valueKind, 'category', 'incompatible IFC measure dimensions are never summable');
    assert.equal(mixed && reader.read(52, mixed.binding), '1');
    assert.equal(mixed && reader.read(395, mixed.binding), '2');
  });

  it('reads multi-valued property shapes as categories by their display and never as numbers, whatever their member count', async () => {
    // Shape is a property of the DEFINITION, not of how many members one
    // occurrence happens to carry: a one-member list is a list and an
    // upper-bound-only bounded value is a range (#4833).
    const store = await parseSampleWith(`
#60003=IFCPROPERTYENUMERATEDVALUE('Multi',$,(IFCLABEL('A'),IFCLABEL('B')),$);
#60010=IFCPROPERTYLISTVALUE('Singleton',$,(IFCLABEL('Only')),$);
#60011=IFCPROPERTYSINGLEVALUE('Inner',$,IFCLABEL('A'),$);
#60012=IFCCOMPLEXPROPERTY('Complex',$,'Usage',(#60011));
#60013=IFCPROPERTYBOUNDEDVALUE('UpperOnly',$,IFCLENGTHMEASURE(5.),$,$,$);
#60014=IFCPROPERTYLISTVALUE('OneNumber',$,(IFCLENGTHMEASURE(7.)),$);
#60015=IFCPROPERTYENUMERATEDVALUE('Status',$,(IFCLABEL('NEW')),$);
#60016=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#60017=IFCPROPERTYLISTVALUE('Lengths',$,(IFCLENGTHMEASURE(1.),IFCLENGTHMEASURE(2.)),#60016);
#60006=IFCPROPERTYSET('g-shapes',#1,'Probe',$,(#60003,#60010,#60012,#60013,#60014,#60015,#60017));
#60008=IFCRELDEFINESBYPROPERTIES('g-rel',#1,$,$,(#52),#60006);`);
    const reader = createElementFieldReader(store);
    const category = (propertyName: string): ElementFieldBinding => ({ kind: 'property', psetName: 'Probe', propertyName, valueKind: 'category' });
    const number = (propertyName: string): ElementFieldBinding => ({ kind: 'property', psetName: 'Probe', propertyName, valueKind: 'number', dataType: 'IFCLENGTHMEASURE' });

    // A list/enumeration carries the type its members share (#5224).
    assert.deepEqual(reader.readResolved(52, category('Multi')), { value: 'A, B', status: 'value', dataType: 'IFCLABEL' });
    // A shaped value keeps its provenance so the dataset can unit-qualify the category (review find).
    assert.deepEqual(reader.readResolved(52, category('Lengths')), { value: '1, 2', status: 'value', unit: 'm', unitSiScale: 1, dataType: 'IFCLENGTHMEASURE' });
    assert.deepEqual(reader.readResolved(52, category('Singleton')), { value: 'Only', status: 'value', dataType: 'IFCLABEL' });
    assert.deepEqual(reader.readResolved(52, category('Status')), { value: 'NEW', status: 'value', dataType: 'IFCLABEL' });
    assert.deepEqual(reader.readResolved(52, category('Complex')), { value: 'Inner: A', status: 'value' });
    assert.deepEqual(reader.readResolved(52, number('UpperOnly')), { value: null, status: 'unsupported' }, 'a bound is not a value');
    assert.deepEqual(reader.readResolved(52, number('OneNumber')), { value: null, status: 'unsupported' }, 'a one-member list is not a scalar');
    assert.deepEqual(reader.readResolved(52, number('Multi')), { value: null, status: 'unsupported' });

    const offered = reader.discover([52]).properties.get('Probe') ?? [];
    const kindOf = (name: string) => offered.find(({ binding }) => binding.kind === 'property' && binding.propertyName === name)?.binding.valueKind;
    assert.equal(kindOf('UpperOnly'), 'category', 'a bounded value is never offered for summing');
    assert.equal(kindOf('OneNumber'), 'category');
    assert.equal(kindOf('Status'), 'category');
  });

  it('inherited type properties survive an idle overlay, and an explicit unit of the wrong dimension or with an unreadable factor is reported unresolved (#4833 review)', async () => {
    const store = await parseSampleWith(`
#60030=IFCMONETARYUNIT('EUR');
#60031=IFCPROPERTYSINGLEVALUE('LengthInEuros',$,IFCLENGTHMEASURE(1.),#60030);
#60032=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#60033=IFCDERIVEDUNITELEMENT(#60032,1);
#60034=IFCDERIVEDUNITELEMENT(#60099,-1);
#60035=IFCDERIVEDUNIT((#60033,#60034),.LINEARVELOCITYUNIT.,$);
#60036=IFCPROPERTYSINGLEVALUE('Speed',$,IFCLINEARVELOCITYMEASURE(3.),#60035);
#60006=IFCPROPERTYSET('g-units',#1,'Probe',$,(#60031,#60036));
#60008=IFCRELDEFINESBYPROPERTIES('g-rel',#1,$,$,(#52),#60006);`);
    const idle = new MutablePropertyView(store.properties, 'fixture');
    idle.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
    assert.equal(createElementFieldReader(store, idle).read(52, SPREAD), 'A2 s1 d0', 'a type-only property is still inherited once an overlay exists');
    const reader = createElementFieldReader(store);
    const euros = reader.readResolved(52, { kind: 'property', psetName: 'Probe', propertyName: 'LengthInEuros', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' });
    assert.equal(euros.unit, '#60030', 'a currency is not a length unit');
    assert.equal(euros.unitSiScale, undefined);
    const speed = reader.readResolved(52, { kind: 'property', psetName: 'Probe', propertyName: 'Speed', valueKind: 'number', dataType: 'IFCLINEARVELOCITYMEASURE' });
    assert.equal(speed.unit, '#60035', 'a derived unit with a dangling factor has no trustworthy scale');
    assert.equal(speed.unitSiScale, undefined);
  });

  it('reads the relation-borne families of the committed sample: material, quantity, defining type and spatial container', async () => {
    const bytes = await readFile(SAMPLE);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const reader = createElementFieldReader(store);
    assert.deepEqual(reader.readResolved(52, { kind: 'material', valueKind: 'category' }), { value: 'concrete_reinforced_in-situ', status: 'value' });
    assert.deepEqual(reader.readResolved(52, { kind: 'type', valueKind: 'category' }), { value: 'house - groundfloor', status: 'value' });
    assert.deepEqual(
      reader.readResolved(52, { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea', valueKind: 'number', dataType: 'IFCAREAMEASURE' }),
      { value: 25.749999999991743, status: 'value', dataType: 'IFCAREAMEASURE' },
    );
    assert.equal(reader.readResolved(52, { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'Depth', valueKind: 'number' }).dataType, 'IFCLENGTHMEASURE');
    assert.equal(reader.readResolved(52, { kind: 'spatial', level: 'Building', valueKind: 'category' }).status, 'value');
    assert.equal(reader.readResolved(52, { kind: 'classification', valueKind: 'category' }).status, 'missing', 'the sample classifies the project, not the slab');

    const catalog = reader.discover([52]);
    const netArea = catalog.quantities.get('Qto_SlabBaseQuantities')?.find(({ binding }) => binding.kind === 'quantity' && binding.quantityName === 'NetArea')?.binding;
    assert.deepEqual(netArea, { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea', valueKind: 'number', dataType: 'IFCAREAMEASURE' });
    const relation = (kind: string) => catalog.relations.find(({ binding }) => binding.kind === kind);
    assert.equal(relation('material')?.observedValue, true);
    assert.equal(relation('type')?.observedValue, true);
    assert.equal(relation('classification')?.observedValue, false);
  });

  it('quantities honour the overlay: a deleted occurrence quantity stays missing, type-owned quantities survive an overlay (#4833 review)', async () => {
    const bytes = await readFile(SAMPLE);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const netArea: ElementFieldBinding = { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea', valueKind: 'number', dataType: 'IFCAREAMEASURE' };
    // A view with no quantity extractor (the server-hydrated shape) and no edits must not hide the provider's quantities.
    const idle = new MutablePropertyView(store.properties, 'fixture');
    assert.equal(createElementFieldReader(store, idle).readResolved(52, netArea).value, 25.749999999991743);
    // Deleting the occurrence quantity keeps it missing even though the same set could be found by falling back.
    const edited = new MutablePropertyView(store.properties, 'fixture');
    edited.setQuantityExtractor((id) => extractQuantitiesOnDemand(store, id));
    edited.deleteQuantity(52, 'Qto_SlabBaseQuantities', 'NetArea');
    assert.equal(createElementFieldReader(store, edited).readResolved(52, netArea).status, 'missing');
    assert.equal(createElementFieldReader(store, edited).readResolved(52, { ...netArea, quantityName: 'Depth' }).value, 250.00000000009484, 'sibling quantities are untouched');
    // A quantity edited without naming a unit keeps its explicit scale; a category read carries it too.
    const scaled = await parseSampleWith(`
#60040=IFCSIUNIT(*,.LENGTHUNIT.,.CENTI.,.METRE.);
#60041=IFCQUANTITYLENGTH('Girth',$,#60040,12.,$);
#60042=IFCELEMENTQUANTITY('g-qto',#1,'Qto_Probe',$,$,(#60041));
#60043=IFCRELDEFINESBYPROPERTIES('g-qto-rel',#1,$,$,(#52),#60042);`);
    const girth: ElementFieldBinding = { kind: 'quantity', qsetName: 'Qto_Probe', quantityName: 'Girth', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' };
    assert.equal(createElementFieldReader(scaled).readResolved(52, girth).unitSiScale, 0.01);
    assert.equal(createElementFieldReader(scaled).readResolved(52, { ...girth, valueKind: 'category' }).unitSiScale, 0.01, 'a category read keeps the scale so it can be unit-qualified');
    const editedScale = new MutablePropertyView(scaled.properties, 'fixture');
    editedScale.setQuantityExtractor((id) => extractQuantitiesOnDemand(scaled, id));
    editedScale.setQuantity(52, 'Qto_Probe', 'Girth', 15, QuantityType.Length);
    assert.deepEqual(createElementFieldReader(scaled, editedScale).readResolved(52, girth), { value: 15, status: 'value', dataType: 'IFCLENGTHMEASURE', unitSiScale: 0.01 });
  });

  it('a type property every occurrence overrides does not shape the field: a label on the type under numbers on the occurrences is a number (#4833 review)', async () => {
    // The slab type #50 gains Probe.Load as a LABEL; its only occurrence #52 carries Probe.Load as a REAL.
    const store = await parseSampleWith(`
#60060=IFCPROPERTYSINGLEVALUE('Load',$,IFCLABEL('heavy'),$);
#60061=IFCPROPERTYSET('g-type-probe',#1,'Probe',$,(#60060));
#60062=IFCPROPERTYSINGLEVALUE('Load',$,IFCREAL(12.5),$);
#60063=IFCPROPERTYSET('g-occ-probe',#1,'Probe',$,(#60062));
#60064=IFCRELDEFINESBYPROPERTIES('g-occ-rel',#1,$,$,(#52),#60063);`, (source) => {
      assert.ok(source.includes('(#963)'), 'the slab type #50 still lists its HasPropertySets as (#963)');
      return source.replace('(#963)', '(#963,#60061)');
    });
    const reader = createElementFieldReader(store);
    const load = reader.discover([52]).properties.get('Probe')?.find(({ binding }) => binding.kind === 'property' && binding.propertyName === 'Load')?.binding;
    assert.equal(load?.valueKind, 'number', 'the overridden type label must not make the field categorical');
    assert.equal(reader.read(52, load!), 12.5);
    // Type-only properties still contribute their shape.
    assert.equal(reader.discover([52]).properties.get('Pset_SlabCommon')?.some(({ binding }) => binding.kind === 'property' && binding.propertyName === 'SurfaceSpreadOfFlame'), true);
  });

  it('a property deleted on the occurrence does not let the type shape the field it no longer reads (#4833 review)', async () => {
    const store = await parseSampleWith(`
#60060=IFCPROPERTYSINGLEVALUE('Load',$,IFCLABEL('heavy'),$);
#60061=IFCPROPERTYSET('g-type-probe',#1,'Probe',$,(#60060));
#60062=IFCPROPERTYSINGLEVALUE('Load',$,IFCREAL(12.5),$);
#60063=IFCPROPERTYSET('g-occ-probe',#1,'Probe',$,(#60062));
#60064=IFCRELDEFINESBYPROPERTIES('g-occ-rel',#1,$,$,(#52),#60063);`, (source) => source.replace('(#963)', '(#963,#60061)'));
    const view = new MutablePropertyView(store.properties, 'fixture');
    view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
    assert.ok(view.deleteProperty(52, 'Probe', 'Load'), 'the occurrence property exists in the base and can be deleted');
    const reader = createElementFieldReader(store, view);
    const load = reader.discover([52]).properties.get('Probe')?.find(({ binding }) => binding.kind === 'property' && binding.propertyName === 'Load')?.binding;
    assert.notEqual(load?.valueKind, 'category', 'the suppressed type label must not make the deleted field categorical');
    assert.equal(reader.read(52, { kind: 'property', psetName: 'Probe', propertyName: 'Load', valueKind: 'category' }), null);
  });

  it('a classification association whose reference has neither code nor name is not an observed value (#4833 review)', async () => {
    const store = await parseSampleWith(`
#60080=IFCCLASSIFICATION('X',$,$,'Sys',$,$,$);
#60081=IFCCLASSIFICATIONREFERENCE($,$,$,#60080,$,$);
#60082=IFCRELASSOCIATESCLASSIFICATION('g-cls',#1,$,$,(#52),#60081);`);
    const reader = createElementFieldReader(store);
    const relations = reader.discover([52]).relations;
    assert.equal(relations.find(({ binding }) => binding.kind === 'classification' && !binding.system)?.observedValue, false);
    assert.equal(relations.some(({ binding }) => binding.kind === 'classification' && binding.system === 'Sys'), false, 'a system with nothing displayable is not offered');
    assert.equal(reader.readResolved(52, { kind: 'classification', valueKind: 'category' }).status, 'missing');
  });

  it('never offers an entity-reference attribute as a value, even though its STEP slot holds a number', async () => {
    const store = await parseSampleWith(`
#60020=IFCDIRECTION((0.,0.,1.));
#60021=IFCSTRUCTURALCURVEMEMBER('g-member',#1,'Member',$,$,$,$,.RIGID_JOINED_MEMBER.,#60020);`);
    const reader = createElementFieldReader(store);
    const catalog = reader.discover([60021]);
    const names = catalog.attributes.map(({ binding }) => binding.kind === 'attribute' ? binding.attributeName : '');
    assert.ok(names.includes('PredefinedType'), names.join(','));
    assert.ok(!names.includes('Axis'), 'IfcStructuralCurveMember.Axis is an IfcDirection reference, not a measure');
    assert.deepEqual(
      reader.readResolved(60021, { kind: 'attribute', attributeName: 'Axis', valueKind: 'number' }),
      { value: null, status: 'unsupported' },
      'a persisted binding to a reference attribute reads unsupported rather than as the referenced id',
    );
  });

  it('family bindings honour their persisted kind, and an overlay edit keeps sibling quantities (#4833 review)', async () => {
    const bytes = await readFile(SAMPLE);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const reader = createElementFieldReader(store);
    assert.deepEqual(reader.readResolved(52, persisted('{"kind":"material","valueKind":"number"}')), { value: null, status: 'unsupported' });
    assert.deepEqual(reader.readResolved(52, persisted('{"kind":"type","valueKind":"boolean"}')), { value: null, status: 'unsupported' });
    assert.deepEqual(reader.readResolved(52, persisted('{"kind":"quantity","qsetName":"Qto_SlabBaseQuantities","quantityName":"NetArea","valueKind":"boolean"}')), { value: null, status: 'unsupported' });
    assert.equal(reader.readResolved(52, { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea', valueKind: 'category' }).value, '25.749999999991743');
    // A view without a quantity extractor that edits one quantity keeps the untouched siblings and sets.
    const view = new MutablePropertyView(store.properties, 'fixture');
    view.setQuantity(52, 'Qto_SlabBaseQuantities', 'NetArea', 30, QuantityType.Area);
    const edited = createElementFieldReader(store, view);
    assert.equal(edited.readResolved(52, { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea', valueKind: 'number' }).value, 30);
    assert.equal(edited.readResolved(52, { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'Depth', valueKind: 'number' }).value, 250.00000000009484, 'the untouched sibling survives the overlay');
  });

  it('a type quantity the occurrence overrides does not shape the field, a type-derived edit keeps the type scale, and two same-named base sets both contribute (#4833 review)', async () => {
    // Slab type #50 gains Qto_Probe.Size as a LENGTH in centimetres and Qto_Probe.Extra; occurrence #52 carries Qto_Probe.Size as an AREA.
    const store = await parseSampleWith(`
#60070=IFCSIUNIT(*,.LENGTHUNIT.,.CENTI.,.METRE.);
#60071=IFCQUANTITYLENGTH('Size',$,#60070,40.,$);
#60072=IFCQUANTITYLENGTH('Extra',$,$,7.,$);
#60073=IFCELEMENTQUANTITY('g-type-qto',#1,'Qto_Probe',$,$,(#60071,#60072));
#60074=IFCQUANTITYAREA('Size',$,$,9.,$);
#60075=IFCELEMENTQUANTITY('g-occ-qto',#1,'Qto_Probe',$,$,(#60074));
#60076=IFCRELDEFINESBYPROPERTIES('g-occ-qto-rel',#1,$,$,(#52),#60075);`, (source) => {
      assert.ok(source.includes('(#963)'));
      return source.replace('(#963)', '(#963,#60073)');
    });
    const reader = createElementFieldReader(store);
    const size = reader.discover([52]).quantities.get('Qto_Probe')?.find(({ binding }) => binding.kind === 'quantity' && binding.quantityName === 'Size')?.binding;
    assert.equal(size?.valueKind, 'number', 'the overridden type length must not make the area categorical');
    assert.equal(size?.dataType, 'IFCAREAMEASURE');
    // A type-derived quantity edited on the type object keeps the type's explicit centimetre scale.
    const view = new MutablePropertyView(store.properties, 'fixture');
    view.setQuantity(50, 'Qto_Probe', 'Extra', 8, QuantityType.Length);
    const extra = createElementFieldReader(store, view).readResolved(52, { kind: 'quantity', qsetName: 'Qto_Probe', quantityName: 'Extra', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' });
    assert.equal(extra.value, 8);
    const sizeOnType = createElementFieldReader(store, view).readResolved(52, { kind: 'quantity', qsetName: 'Qto_Probe', quantityName: 'Size', valueKind: 'number', dataType: 'IFCAREAMEASURE' });
    assert.equal(sizeOnType.value, 9, 'the occurrence area still wins');
    const typeView = new MutablePropertyView(store.properties, 'fixture');
    typeView.setQuantity(50, 'Qto_Probe', 'Size', 41, QuantityType.Length);
    // Occurrence #52 overrides Size, so the type edit is only visible on an element without its own Size: read the type quantity via a fresh store where the occurrence set is absent.
    const typeOnly = await parseSampleWith(`
#60070=IFCSIUNIT(*,.LENGTHUNIT.,.CENTI.,.METRE.);
#60071=IFCQUANTITYLENGTH('Size',$,#60070,40.,$);
#60073=IFCELEMENTQUANTITY('g-type-qto',#1,'Qto_Probe',$,$,(#60071));`, (source) => source.replace('(#963)', '(#963,#60073)'));
    const typeOnlyView = new MutablePropertyView(typeOnly.properties, 'fixture');
    typeOnlyView.setQuantity(50, 'Qto_Probe', 'Size', 41, QuantityType.Length);
    assert.deepEqual(createElementFieldReader(typeOnly, typeOnlyView).readResolved(52, { kind: 'quantity', qsetName: 'Qto_Probe', quantityName: 'Size', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' }), { value: 41, status: 'value', dataType: 'IFCLENGTHMEASURE', unitSiScale: 0.01 }, 'an edit on the type keeps the type quantity\'s explicit centimetre scale');
  });
});
