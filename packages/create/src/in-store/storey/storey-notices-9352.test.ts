/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { IfcCreator } from '../../ifc-creator.js';
import { addStoreyInStore } from './storey-add.js';
import { planStoreyLevelEdit } from './storey-level-plan.js';
import { readStoreyInventory } from './storey-model.js';
import { writeTopAttachment } from './storey-attachment.js';
import { parse, session } from '../__test__/storey-fixtures.oracle.js';

for (const elementType of ['IfcColumn', 'IfcBeam', 'IfcMember', 'IfcCurtainWall'] as const) {
  for (const unresolved of [false, true]) it(`#9352 ${elementType} top notices identify their own kind (unresolved=${unresolved})`, async () => {
    const c = new IfcCreator({ Name: 'Notices' });
    c.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
    const s = session(await parse(c.toIfc().content));
    const home = readStoreyInventory(s.store, s.view).storeys[0];
    const upper = addStoreyInStore(s.store, s.editor, { Name: 'Upper', Elevation: 3 }).storeyId;
    const guid = readStoreyInventory(s.store, s.view).storeys.find(row => row.expressId === upper)!.GlobalId;
    const id = s.editor.addEntity(elementType, ['0000000000000000000001', null, elementType, null, null, `#${home.placementId}`, null, null, '.NOTDEFINED.']).expressId;
    s.editor.addEntity('IfcRelContainedInSpatialStructure', ['0000000000000000000002', null, null, null, [`#${id}`], `#${home.expressId}`]);
    writeTopAttachment(s.view, id, unresolved ? '0000000000000000000003' : guid, 'relative');
    const plan = planStoreyLevelEdit(readStoreyInventory(s.store, s.view), { kind: 'elevation', storeyId: upper, Elevation: 4 });
    expect(plan.notices).toContainEqual(expect.objectContaining({ code: unresolved ? 'wallAttachmentUnresolved' : 'attachedNotResized', elementType, elementIds: [id] }));
  });
}
