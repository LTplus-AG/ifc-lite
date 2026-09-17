/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, extractPropertiesOnDemand, extractTypeEntityOwnProperties, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { ElementFieldBinding } from '@ifc-lite/charts';
import { createElementFieldReader } from './element-field-reader.js';

const FIRE: ElementFieldBinding = { kind: 'property', psetName: 'Pset_SlabCommon', propertyName: 'FireRating', valueKind: 'category' };
const SPREAD: ElementFieldBinding = { kind: 'property', psetName: 'Pset_SlabCommon', propertyName: 'SurfaceSpreadOfFlame', valueKind: 'category' };
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
    view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
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
    deleted.setOnDemandExtractor((id) => id === 50 ? extractTypeEntityOwnProperties(store, id) : extractPropertiesOnDemand(store, id));
    deleted.deleteProperty(50, 'Pset_SlabCommon', 'SurfaceSpreadOfFlame');
    assert.equal(createElementFieldReader(store, deleted).read(52, SPREAD), null);
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

    assert.deepEqual(reader.readResolved(52, category('Multi')), { value: 'A, B', status: 'value' });
    // A shaped value keeps its provenance so the dataset can unit-qualify the category (review find).
    assert.deepEqual(reader.readResolved(52, category('Lengths')), { value: '1, 2', status: 'value', unit: 'm', unitSiScale: 1 });
    assert.deepEqual(reader.readResolved(52, category('Singleton')), { value: 'Only', status: 'value' });
    assert.deepEqual(reader.readResolved(52, category('Status')), { value: 'NEW', status: 'value' });
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

  it('a type property every occurrence overrides does not shape the field: a label on the type under numbers on the occurrences is a number (#4833 review)', async () => {
    // The slab type #50 gains Probe.Load as a LABEL; its only occurrence #52 carries Probe.Load as a REAL.
    const store = await parseSampleWith(`
#60060=IFCPROPERTYSINGLEVALUE('Load',$,IFCLABEL('heavy'),$);
#60061=IFCPROPERTYSET('g-type-probe',#1,'Probe',$,(#60060));
#60062=IFCPROPERTYSINGLEVALUE('Load',$,IFCREAL(12.5),$);
#60063=IFCPROPERTYSET('g-occ-probe',#1,'Probe',$,(#60062));
#60064=IFCRELDEFINESBYPROPERTIES('g-occ-rel',#1,$,$,(#52),#60063);`, (source) => source.replace('(#963)', '(#963,#60061)'));
    const reader = createElementFieldReader(store);
    const load = reader.discover([52]).properties.get('Probe')?.find(({ binding }) => binding.kind === 'property' && binding.propertyName === 'Load')?.binding;
    assert.equal(load?.valueKind, 'number', 'the overridden type label must not make the field categorical');
    assert.equal(reader.read(52, load!), 12.5);
    // Type-only properties still contribute their shape.
    assert.equal(reader.discover([52]).properties.get('Pset_SlabCommon')?.some(({ binding }) => binding.kind === 'property' && binding.propertyName === 'SurfaceSpreadOfFlame'), true);
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
});
