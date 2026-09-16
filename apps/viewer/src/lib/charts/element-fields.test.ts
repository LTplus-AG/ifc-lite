/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, extractPropertiesOnDemand, extractTypeEntityOwnProperties } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { ElementFieldBinding } from '@ifc-lite/charts';
import { createElementFieldReader } from './element-field-reader.js';

const FIRE: ElementFieldBinding = { kind: 'property', psetName: 'Pset_SlabCommon', propertyName: 'FireRating', valueKind: 'category' };
const SPREAD: ElementFieldBinding = { kind: 'property', psetName: 'Pset_SlabCommon', propertyName: 'SurfaceSpreadOfFlame', valueKind: 'category' };

describe('chart IFC field reader (#4833)', () => {
  it('uses occurrence precedence and type-only fallback on the committed authoring fixture', async () => {
    const bytes = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const reader = createElementFieldReader(store);

    assert.equal(reader.read(52, FIRE), 'REI30', 'occurrence FireRating wins over the type REI60');
    assert.equal(reader.read(52, SPREAD), 'A2 s1 d0', 'a missing occurrence property falls back to the defining type');
    const catalog = reader.discover([52]);
    assert.ok(catalog.properties.get('Pset_SlabCommon')?.some(({ binding }) => binding.kind === 'property' && binding.propertyName === 'SurfaceSpreadOfFlame'));
  });

  it('keeps explicit null and deletion missing instead of resurrecting the type value', async () => {
    const bytes = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const view = new MutablePropertyView(store.properties, 'fixture');
    view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
    view.setProperty(52, 'Pset_SlabCommon', 'FireRating', null);
    assert.equal(createElementFieldReader(store, view).read(52, FIRE), null);
    view.deleteProperty(52, 'Pset_SlabCommon', 'FireRating');
    assert.equal(createElementFieldReader(store, view).read(52, FIRE), null);
  });

  it('applies defining-type edits and deletions before inherited fallback', async () => {
    const bytes = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
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

  it('preserves explicit units and rejects multi-valued properties as unsupported', async () => {
    const fixture = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
    const extra = `
#60001=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#60002=IFCPROPERTYSINGLEVALUE('ExplicitLength',$,IFCLENGTHMEASURE(1.),#60001);
#60003=IFCPROPERTYENUMERATEDVALUE('Multi',$,(IFCLABEL('A'),IFCLABEL('B')),$);
#60004=IFCPROPERTYSINGLEVALUE('MixedMeasure',$,IFCLENGTHMEASURE(1.),$);
#60005=IFCPROPERTYSINGLEVALUE('MixedMeasure',$,IFCAREAMEASURE(2.),$);
#60010=IFCPROPERTYLISTVALUE('Singleton',$,(IFCLABEL('Only')),$);
#60011=IFCPROPERTYSINGLEVALUE('Inner',$,IFCLABEL('A'),$);
#60012=IFCCOMPLEXPROPERTY('Complex',$,'Usage',(#60011));
#60006=IFCPROPERTYSET('g-explicit',#1,'Probe',$,(#60002,#60003,#60004,#60010,#60012));
#60007=IFCPROPERTYSET('g-area',#1,'Probe',$,(#60005));
#60008=IFCRELDEFINESBYPROPERTIES('g-rel',#1,$,$,(#52),#60006);
#60009=IFCRELDEFINESBYPROPERTIES('g-area-rel',#1,$,$,(#395),#60007);`;
    const source = fixture.replace('ENDSEC;\nEND-ISO-10303-21;', `${extra}\nENDSEC;\nEND-ISO-10303-21;`);
    const bytes = new TextEncoder().encode(source);
    const store = await new IfcParser().parseColumnar(bytes.buffer);
    const reader = createElementFieldReader(store);
    const length: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'ExplicitLength', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' };
    const multi: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'Multi', valueKind: 'category' };
    const singleton: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'Singleton', valueKind: 'category' };
    const complex: ElementFieldBinding = { kind: 'property', psetName: 'Probe', propertyName: 'Complex', valueKind: 'category' };
    assert.deepEqual(reader.readResolved(52, length), { value: 1, status: 'value', unit: 'm', dataType: 'IFCLENGTHMEASURE' });
    assert.deepEqual(reader.readResolved(52, multi), { value: null, status: 'unsupported' });
    assert.deepEqual(reader.readResolved(52, singleton), { value: 'Only', status: 'value' });
    assert.deepEqual(reader.readResolved(52, complex), { value: null, status: 'unsupported' });
    const overlay = new MutablePropertyView(store.properties, 'fixture');
    overlay.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
    const overlayReader = createElementFieldReader(store, overlay);
    assert.deepEqual(overlayReader.readResolved(52, length), { value: 1, status: 'value', unit: 'm', dataType: 'IFCLENGTHMEASURE' });
    assert.deepEqual(overlayReader.readResolved(52, multi), { value: null, status: 'unsupported' });
    const mixed = reader.discover([52, 395]).properties.get('Probe')?.find(({ binding }) => binding.kind === 'property' && binding.propertyName === 'MixedMeasure');
    assert.equal(mixed?.binding.valueKind, 'category', 'incompatible IFC measure dimensions are never summable');
    assert.equal(mixed && reader.read(52, mixed.binding), '1');
    assert.equal(mixed && reader.read(395, mixed.binding), '2');
  });
});
