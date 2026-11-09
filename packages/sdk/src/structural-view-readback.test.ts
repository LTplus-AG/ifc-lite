/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { overlayFromView } from './headless/overlay.js';
import { createEffectiveRecordOverlay } from './effective-record-overlay.js';
import { effectiveCostReferenceOccurrences } from './cost-reference-scan.js';

async function fixture() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(`ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);ENDSEC;END-ISO-10303-21;`).buffer as ArrayBuffer);
  const view = new MutablePropertyView(null, 'structural');
  const editor = new StoreEditor(store, view);
  const wall = editor.addEntity('IfcWall', ['0000000000000000000002', null, 'Authored wall', null, null, null, null, null, null]).expressId;
  const relation = editor.addEntity('IfcRelAggregates', ['0000000000000000000003', null, null, null, '#1', [`#${wall}`]]).expressId;
  view.setAttribute(wall, 'Name', 'Edited wall');
  // #9411: hide plural and singular borrow APIs, retaining original getters.
  const legacy = new Proxy(view, { get(target, key, receiver) {
    return key === 'readNewEntities' || key === 'readNewEntity' ? undefined : Reflect.get(target, key, receiver);
  } });
  return { store, legacy, wall, relation };
}

it('#9411 headless inventory and point readback support structural views', async () => {
  const { store, legacy, wall } = await fixture();
  const overlay = overlayFromView(legacy, store);
  expect(overlay?.createdAll.find(entity => entity.expressId === wall)?.name).toBe('Edited wall');
  expect(overlay?.createdEntity(wall)?.name).toBe('Edited wall');
});

it('#9411 structural headless views retain authored relationship edges', async () => {
  const { store, legacy, wall, relation } = await fixture();
  expect(overlayFromView(legacy, store)?.relationshipEdges(1, 'IfcRelAggregates'))
    .toEqual(expect.arrayContaining([expect.objectContaining({ targetId: wall, relationshipId: relation })]));
});

it('#9411 cost records and deletion guards support structural views', async () => {
  const { store, legacy, wall, relation } = await fixture();
  const records = createEffectiveRecordOverlay(legacy, store).created();
  expect(records.find(record => record.expressId === wall)).toMatchObject({ type: 'IfcWall' });
  expect(effectiveCostReferenceOccurrences(store, legacy, new Set([wall])).get(wall)).toEqual(new Map([[relation, 1]]));
});
