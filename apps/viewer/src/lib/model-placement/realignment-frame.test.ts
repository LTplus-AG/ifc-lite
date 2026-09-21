/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import type { ModelSpatialPlacement } from '@/hooks/ingest/federationAlign';
import { spatialReferenceFromIfc } from '@/lib/geo/ifc-spatial-reference';
import { emptyPlacementState } from './state';
import { commitRealignmentFrame } from './realignment-frame';

const georef: ModelSpatialPlacement = {
  spatialReference: spatialReferenceFromIfc({
    mapConversion: { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 200, northings: 300,
      orthogonalHeight: 4, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
    projectedCRS: { id: 4, name: 'EPSG:2056' }, lengthUnitScale: 1,
  }),
};
for (const replacement of [false, true]) it(`refuses the old frame after a pending realignment loses its federation (replacement: ${replacement}, #4226)`, async () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('old')), modelPlacement: emptyPlacementState() });
  const snapshot = useViewerStore.getState().models;
  let resume!: () => void;
  const pending = new Promise<void>((resolve) => { resume = resolve; });
  const completion = pending.then(() => commitRealignmentFrame(snapshot, georef));
  useViewerStore.setState({ models: replacement ? new Map([['old', fixtureModel('old')]]) : new Map(), modelPlacement: emptyPlacementState() });
  resume();
  assert.equal(await completion, false);
  assert.equal(useViewerStore.getState().modelPlacement.realignedFrameKey, null, 'fresh workspace never adopts the completed old job frame');
});
it('accepts status updates on the same federation and preserves explicit model offsets (#4226)', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), modelPlacement: emptyPlacementState() });
  const snapshot = useViewerStore.getState().models;
  const state = useViewerStore.getState();
  state.openReposition(['m']); state.previewModelTranslation([1, 2, 3]); state.applyModelTranslation();
  useViewerStore.getState().updateModel('m', { federationAlignmentStatus: 'anchor' });
  assert.equal(commitRealignmentFrame(snapshot, georef), true);
  assert.match(useViewerStore.getState().modelPlacement.realignedFrameKey!, /EPSG:2056/);
  assert.deepEqual(useViewerStore.getState().modelPlacement.placements.get('m')?.translation, [1, 2, 3]);
});

it('keeps the same coordinate frame across renamed or revised anchors (#4226)', () => {
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('old'), sourceFingerprint: 'old.ifc:abc' }), modelPlacement: emptyPlacementState() });
  commitRealignmentFrame(useViewerStore.getState().models, georef);
  const frame = useViewerStore.getState().modelPlacement.realignedFrameKey;
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('new'), sourceFingerprint: 'new.ifc:xyz' }), modelPlacement: emptyPlacementState() });
  commitRealignmentFrame(useViewerStore.getState().models, georef);
  assert.equal(useViewerStore.getState().modelPlacement.realignedFrameKey, frame);
  commitRealignmentFrame(useViewerStore.getState().models, { ...georef, spatialReference: {
    ...georef.spatialReference, localToProjected: { ...georef.spatialReference.localToProjected!, scaleX: 0.001 },
  } });
  assert.notEqual(useViewerStore.getState().modelPlacement.realignedFrameKey, frame);
  // An IfcMapConversionScaled factor changes the frame as much as Scale does (#4615).
  commitRealignmentFrame(useViewerStore.getState().models, { ...georef, spatialReference: {
    ...georef.spatialReference, localToProjected: { ...georef.spatialReference.localToProjected!, scaleZ: 2 },
  } });
  assert.notEqual(useViewerStore.getState().modelPlacement.realignedFrameKey, frame);
});
