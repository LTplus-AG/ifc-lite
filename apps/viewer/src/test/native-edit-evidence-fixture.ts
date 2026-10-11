/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from '@/store';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc } from './authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readAuthoringSize } from '@/lib/actions/model-authoring-size';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
const s = useViewerStore.getState;
const idOf = (outcome: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in outcome, 'error' in outcome ? outcome.error : '');
  return outcome.expressId;
};
export const nativeProfile = { Type: 'RectangleHollow' as const, XDim: .25, YDim: .4, WallThickness: .015, InnerFilletRadius: 0, OuterFilletRadius: .005 };

export async function nativeEditTargets(metres = false) {
  let { dataStore } = await seedAuthoringSample();
  if (metres) {
    const text = await readFile(new URL('../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
    assert.match(text, /IFCSIUNIT\(\*,\.LENGTHUNIT\.,\.MILLI\.,\.METRE\.\)/);
    dataStore = await parseIfc(new TextEncoder().encode(text.replace('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)')));
    const model = s().models.get(SAMPLE_MODEL)!;
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: dataStore }]]), ifcDataStore: dataStore,
      mutationViews: new Map([[SAMPLE_MODEL, new MutablePropertyView(dataStore.properties, SAMPLE_MODEL)]]), storeEditors: new Map() });
  }
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const wall = idOf(s().addWall(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3, Name: 'Native editable wall' }));
  const beam = idOf(s().addBeam(SAMPLE_MODEL, storey, { Start: [0, 0, 4], End: [4, 0, 4], Profile: nativeProfile, Name: 'Native editable hollow beam' }));
  const model = s().models.get(SAMPLE_MODEL)!;
  const exported = await parseIfc(editedModelBytes(model.ifcDataStore!, s().mutationViews.get(SAMPLE_MODEL) ?? null));
  const readback: ViewerState = { ...s(), models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: exported }]]),
    mutationViews: new Map([[SAMPLE_MODEL, new MutablePropertyView(exported.properties, SAMPLE_MODEL)]]), storeEditors: new Map() };
  assert.deepEqual(readAuthoringSize(readback, SAMPLE_MODEL, wall, 'wall'), { kind: 'wall', height: 3, thickness: .2 });
  assert.deepEqual(readElementProfile(readback, SAMPLE_MODEL, beam), nativeProfile, 'independent STEP reparse proves exact section, including zero and optional radius');
  s().addEntityToSelection({ modelId: SAMPLE_MODEL, expressId: wall });
  s().addEntityToSelection({ modelId: SAMPLE_MODEL, expressId: beam });
  return { wall, beam, exported };
}

