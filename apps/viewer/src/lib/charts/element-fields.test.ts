/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
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
});
