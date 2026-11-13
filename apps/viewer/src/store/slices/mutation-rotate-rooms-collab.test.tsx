/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act } from 'react';
import { getEntityPlacement } from '@ifc-lite/collab';
import { useViewerStore } from '@/store';
import { Toaster } from '@/components/ui/toast';
import { render, cleanup, click } from '@/test/render';
import { toGlobalIdFromModels } from '@/store/globalId';
import { pathForEntity } from '@/lib/collab/entity-paths';
import { WALL, WALL_MODEL, WALL_UNITS, seedRectangleWall } from '@/test/rectangle-wall-fixture';

const withRoom = (step: string) => step.replace('ENDSEC;\nEND-ISO', `
#90=IFCSPACE('1cUkl32yn9qRSPvBJVyWYa',$,'Room',$,'IfcLite:GeneratedSpace',$,$,$,.ELEMENT.,.INTERNAL.,$);
#91=IFCBUILDINGSTOREY('2cUkl32yn9qRSPvBJVyWYa',$,'Other storey',$,$,#41,$,$,.ELEMENT.,3.);
#92=IFCRELAGGREGATES('0cUkl32yn9qRSPvBJVyWYa',$,$,$,#91,(#90));
ENDSEC;\nEND-ISO`);

for (const mode of ['unresolved', 'vertical'] as const) it(`#9296 shared STEP ${mode} rotation preserves refusals and room notices`, async () => {
  await seedRectangleWall(WALL_UNITS[0].unit, 1, step => mode === 'unresolved'
    ? withRoom(step).replace('#51=IFCLOCALPLACEMENT(#41,#52);', '#51=IFCLOCALPLACEMENT(#41,$);')
    : withRoom(step).replace('#55=IFCDIRECTION((1.,0.,0.));', '#55=IFCDIRECTION((0.,0.,1.));'));
  const state = useViewerStore.getState(), model = state.models.get(WALL_MODEL)!;
  const data = model.ifcDataStore!, view = state.mutationViews.get(WALL_MODEL)!;
  try {
    await state.startCollab({ roomId: `rotation-rooms-9296-${crypto.randomUUID()}`, role: 'admin', seed: { models: [{
      modelId: WALL_MODEL, name: 'fixture.ifc', store: data, isIfcx: false,
      meshes: model.geometryResult!.meshes, idOffset: model.idOffset, schemaVersion: 'IFC4',
    }] } });
    const session = useViewerStore.getState().collabSession;
    assert.ok(session, 'real local collaboration session starts');
    const path = pathForEntity(data, WALL)!;
    const roomPath = pathForEntity(data, 90)!;
    const beforeWall = getEntityPlacement(session.doc, path);
    const beforeRoom = getEntityPlacement(session.doc, roomPath);
    const history = view.getMutationCount();
    const ui = render(<Toaster />);
    for (const button of ui.querySelectorAll('button')) click(button);
    useViewerStore.setState({ pendingMeshRotations: null });
    act(() => {
      const result = useViewerStore.getState().rotateEntity(WALL_MODEL, WALL, Math.PI / 2);
      assert.equal(result.ok, mode === 'unresolved');
      if (!result.ok) assert.match(result.reason, /RefDirection is vertical/);
    });
    const rotated = getEntityPlacement(session.doc, path);
    if (mode === 'unresolved') {
      assert.ok(rotated?.refDirection);
      assert.ok(Math.abs(rotated.refDirection[0]) < 1e-10);
      assert.ok(Math.abs(rotated.refDirection[1] - 1) < 1e-10);
      const current = useViewerStore.getState();
      const rotation = current.pendingMeshRotations?.get(toGlobalIdFromModels(current.models, WALL_MODEL, WALL));
      assert.ok(rotation && Math.abs(rotation.angle - Math.PI / 2) < 1e-10, 'the live wall mesh also rotates');
    } else {
      assert.deepEqual(rotated, beforeWall, 'a refused edit never reaches the collaboration fallback');
      assert.equal(useViewerStore.getState().pendingMeshRotations, null);
    }
    assert.deepEqual(getEntityPlacement(session.doc, roomPath), beforeRoom, 'the other storey room is untouched');
    assert.equal(view.getMutationCount(), history, 'no unresolved STEP placement or room edit is committed');
    if (mode === 'unresolved') assert.match(ui.textContent ?? '', /Rooms were not updated because the wall placement could not be read/);
    else assert.doesNotMatch(ui.textContent ?? '', /Rooms were not updated/);
  } finally {
    cleanup();
    useViewerStore.getState().stopCollab();
  }
});
