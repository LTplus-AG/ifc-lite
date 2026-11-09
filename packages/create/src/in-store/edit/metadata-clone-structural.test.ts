/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { PropertyTableBuilder, StringTable, PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { cloneEffectiveMetadata } from './metadata-clone-effective.js';

it('#9411 a structural view ignoring the new entity argument cannot copy unrelated metadata', async () => {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(`ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCWALL('0000000000000000000001',$,'Source',$,$,$,$,$,$);
#2=IFCWALL('0000000000000000000002',$,'Unrelated',$,$,$,$,$,$);
#3=IFCWALL('0000000000000000000003',$,'Target',$,$,$,$,$,$);ENDSEC;END-ISO-10303-21;`).buffer as ArrayBuffer);
  const base = new PropertyTableBuilder(new StringTable());
  base.add({ entityId: 1, psetName: 'Pset_Base', psetGlobalId: '', propName: 'Value', value: 'unchanged', propType: PropertyValueType.String });
  const view = new MutablePropertyView(base.build(), 'legacy'), editor = new StoreEditor(store, view);
  view.setProperty(1, 'Pset_Edited', 'Flag', true);
  view.setProperty(2, 'Pset_Base', 'Value', 'unrelated edit');
  const legacy = new Proxy(view, { get(target, key) {
    if (key === 'getEffectiveChanges') return () => target.getEffectiveChanges();
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  cloneEffectiveMetadata(legacy, editor, 1, [3]);
  expect(view.getForEntity(3).map(set => set.name)).toEqual(['Pset_Edited']);
  expect(view.getPropertyValue(3, 'Pset_Edited', 'Flag')).toBe(true);
});
