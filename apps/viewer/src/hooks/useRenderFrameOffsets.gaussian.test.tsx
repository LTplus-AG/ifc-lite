// SPDX-License-Identifier: MPL-2.0
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { createCoordinateInfo } from '@/utils/localParsingUtils.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { bcfWorldOffset } from './bcf/viewpoint-world-frame.js';
import { useRenderFrameOffsets } from './useRenderFrameOffsets.js';

afterEach(() => cleanup());

test('capture loaded before shifted IFC cannot anchor measure or BCF frame (#8752)', () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  const capture = {
    ...fixtureModel('capture'), loadedAt: 1,
    gaussianSplat: { handle: { id: 1, modelIndex: 0 } },
    geometryResult: { coordinateInfo: createCoordinateInfo(bounds, { x: 90, y: 80, z: 70 }) },
  } as FederatedModel;
  const ifc = {
    ...fixtureModel('ifc'), loadedAt: 2,
    geometryResult: { coordinateInfo: createCoordinateInfo(bounds, { x: 10, y: 20, z: 30 }) },
  } as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(capture, ifc), geometryResult: null });
  function Probe() {
    const frame = useRenderFrameOffsets();
    return <output data-testid="frame">{JSON.stringify(frame)}</output>;
  }
  const ui = render(<Probe />);
  const frame = JSON.parse(ui.querySelector('[data-testid="frame"]')!.textContent!);
  assert.deepEqual(frame.originShift, { x: 10, y: 20, z: 30 });
  assert.equal(frame.anchorName, 'ifc');
  assert.deepEqual(bcfWorldOffset(useViewerStore.getState().models, null), { x: 10, y: -30, z: 20 });
});
