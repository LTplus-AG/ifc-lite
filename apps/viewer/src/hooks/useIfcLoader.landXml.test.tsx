/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end load-path regression for #4937. This drives the real LandXML
 * parser through the canonical `useIfcLoader.loadFile` path twice: first as a
 * primary model, then as a federated model. It proves rendering geometry and
 * federation id allocation are not a parallel ingest path.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { isSupportedModelFile } from '@/services/supported-model-files';
import { useIfcLoader } from './useIfcLoader.js';

function landXmlFile(name: string, offsets: number | readonly number[]): File {
  const components = typeof offsets === 'number' ? [offsets] : offsets;
  const xml = `<?xml version="1.0"?>
    <LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
      <Units><Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter"
        temperatureUnit="celsius" pressureUnit="milliBars" elevationUnit="meter"/></Units>
      <Surfaces>${components.map((offset) => `<Surface name="TIN ${offset}"><Definition surfType="TIN">
        <Pnts>
          <P id="1">${offset} ${offset} 0</P>
          <P id="2">${offset} ${offset + 10} 0</P>
          <P id="3">${offset + 10} ${offset} 2</P>
        </Pnts>
        <Faces><F>1 2 3</F></Faces>
      </Definition></Surface>`).join('')}</Surfaces>
    </LandXML>`;
  return new File([xml], name, { type: 'application/xml' });
}

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  assert.ok(hookApi);
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

describe('useIfcLoader LandXML route (#4937)', () => {
  it('loads and federates TIN meshes through the canonical model finalizer', async () => {
    const primary = landXmlFile('terrain.xml', 800_000_000);
    assert.equal(isSupportedModelFile(primary), true, '.xml must be offered by every canonical picker');
    await act(async () => hookApi!.loadFile(primary, { kind: 'primary' }));

    const first = Array.from(useViewerStore.getState().models.values())[0];
    assert.ok(first);
    assert.equal(first.loadFormat, 'landxml');
    assert.equal(first.loadPath, 'landxml');
    assert.equal(first.geometryResult?.totalTriangles, 1);
    assert.equal(first.geometryResult?.meshes[0].expressId, 1);
    assert.equal(useViewerStore.getState().error, null);

    await act(async () => hookApi!.loadFile(
      landXmlFile('terrain-federated.xml', 800_000_100),
      { kind: 'federated', modelId: 'landxml-federated' },
    ));
    const second = useViewerStore.getState().models.get('landxml-federated');
    assert.ok(second?.geometryResult);
    assert.ok(second.idOffset > first.maxExpressId);
    assert.equal(second.geometryResult.meshes[0].expressId, 1 + second.idOffset);
    assert.equal(second.loadPath, 'landxml');
    assert.deepEqual(second.geometryResult.coordinateInfo.originShift, first.geometryResult?.coordinateInfo.originShift);
    const firstOrigin = first.geometryResult?.meshes[0].origin;
    const secondOrigin = second.geometryResult.meshes[0].origin;
    assert.ok(firstOrigin && secondOrigin);
    assert.deepEqual(secondOrigin.map((value, axis) => value - firstOrigin[axis]), [100, 0, -100],
      'federated LandXML keeps survey separation inside one shared render frame');
  });

  for (const [primaryOffset, federatedOffset, order] of [
    [0, 2_000_000, 'near model first'],
    [2_000_000, 0, 'distant model first'],
  ] as const) {
    it(`refuses a compact LandXML model outside the established federation frame (${order})`, async () => {
      await act(async () => hookApi!.loadFile(
        landXmlFile(`anchor-${primaryOffset}.xml`, primaryOffset),
        { kind: 'primary' },
      ));
      const anchor = Array.from(useViewerStore.getState().models.values())[0];
      assert.ok(anchor?.geometryResult);

      await act(async () => hookApi!.loadFile(
        landXmlFile(`outside-${federatedOffset}.xml`, federatedOffset),
        { kind: 'federated', modelId: 'outside-frame' },
      ));

      const state = useViewerStore.getState();
      assert.equal(state.models.size, 1, 'a refused federated terrain is never partially registered');
      assert.equal(state.models.get(anchor.id), anchor, 'the established model remains unchanged');
      assert.equal(state.models.has('outside-frame'), false);
      assert.match(state.error ?? '', /every surface component's full Y-up bounds exceed the 1000 km shared render-frame limit/);
    });
  }

  it('warns and recomputes metadata when only some reframed components fit', async () => {
    await act(async () => hookApi!.loadFile(landXmlFile('anchor.xml', 0), { kind: 'primary' }));
    const messages: string[] = [];
    const originalInfo = toast.info;
    toast.info = (message: string) => { messages.push(message); };
    try {
      await act(async () => hookApi!.loadFile(
        landXmlFile('partially-outside.xml', [900_000, 1_500_000]),
        { kind: 'federated', modelId: 'partially-outside' },
      ));
    } finally {
      toast.info = originalInfo;
    }

    const model = useViewerStore.getState().models.get('partially-outside');
    assert.ok(model?.geometryResult);
    assert.equal(model.geometryResult.meshes.length, 1);
    assert.equal(model.geometryResult.totalVertices, 3);
    assert.equal(model.geometryResult.totalTriangles, 1);
    assert.ok(model.geometryResult.coordinateInfo.originalBounds.max.x < 1_000_000,
      'discarded bounds must not survive in the registered model metadata');
    assert.ok(model.geometryResult.coordinateInfo.shiftedBounds.max.x < 1_000_000,
      'the camera-fit bounds must describe only the retained component');
    const retainedCounts = model.landXmlDocument?.rendering.surfaceCounts;
    assert.ok(retainedCounts);
    assert.deepEqual(retainedCounts.map((counts) => counts.renderedFaces), [1, 0],
      'source inspection counts describe only mesh components that survived federation framing');
    assert.deepEqual(retainedCounts.map((counts) => counts.droppedReframeFaces), [0, 1],
      'the dropped source face remains accounted for as a frame rejection, not rendered geometry');
    assert.ok(messages.some((warning) => /Skipped 1 LandXML surface component.*full Y-up bounds/.test(warning)));
  });
});
