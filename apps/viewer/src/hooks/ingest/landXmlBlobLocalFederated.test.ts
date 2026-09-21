/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { FederationRegistry } from '@ifc-lite/renderer';
import type { FederatedModel } from '../../store/index.js';
import { useViewerStore } from '../../store/index.js';
import { fixtureModel } from '../../test/store-fixture.js';
import { FederatedLandXmlStreamingPlan } from './federatedLandXmlStreaming.js';
import { parseLandXmlViewerModelFromBlobAsync } from './landXmlViewerModel.js';

const NEAR_AND_DISTANT_SURFACES = `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric linearUnit="meter" elevationUnit="meter"/></Units>
  <Surfaces>
    <Surface name="near"><Definition surfType="TIN"><Pnts>
      <P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P>
    </Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface>
    <Surface name="distant"><Definition surfType="TIN"><Pnts>
      <P id="11">0 2000000 0</P><P id="12">0 2000001 0</P><P id="13">1 2000000 0</P>
      <P id="14">1 2000001 0</P>
    </Pnts><Faces><F>11 12 13</F><F>12 14 13</F></Faces></Definition></Surface>
  </Surfaces>
</LandXML>`;

const PRIMARY_SURFACE = `<?xml version="1.0"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric linearUnit="meter" elevationUnit="meter"/></Units>
  <Surfaces><Surface name="primary"><Definition surfType="TIN"><Pnts>
    <P id="1">0 0 0</P><P id="2">0 1 0</P><P id="3">1 0 0</P>
  </Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces>
</LandXML>`;

afterEach(() => useViewerStore.getState().clearAllModels());

it('awaits primary preflight before worker-less raw components begin (#5161)', async () => {
  const originalWorker = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
  const phases: string[] = [];
  let releasePreflight: (() => void) | undefined;
  let reachedPreflight: (() => void) | undefined;
  const preflightReached = new Promise<void>((resolve) => { reachedPreflight = resolve; });
  try {
    const pending = parseLandXmlViewerModelFromBlobAsync(
      new Blob([PRIMARY_SURFACE]),
      () => true,
      undefined,
      () => {
        phases.push('preflight');
        reachedPreflight?.();
        return new Promise<void>((resolve) => { releasePreflight = resolve; });
      },
      (mesh) => { phases.push(`raw:${mesh.expressId}`); },
    );
    await preflightReached;
    assert.deepEqual(phases, ['preflight'], 'the cursor cannot enter its raw pass before primary reservation completes');
    releasePreflight?.();
    await pending;
    assert.deepEqual(phases, ['preflight', 'raw:1']);
  } finally {
    releasePreflight?.();
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
});

it('cancels a held worker-less raw callback before it is released (#5161)', async () => {
  const originalWorker = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
  let current = true;
  let releaseComponent: (() => void) | undefined;
  let enteredComponent: (() => void) | undefined;
  const componentEntered = new Promise<void>((resolve) => { enteredComponent = resolve; });
  try {
    const pending = parseLandXmlViewerModelFromBlobAsync(
      new Blob([PRIMARY_SURFACE]),
      () => current,
      undefined,
      undefined,
      () => {
        enteredComponent?.();
        return new Promise<void>((resolve) => { releaseComponent = resolve; });
      },
    );
    await componentEntered;
    current = false;
    await assert.rejects(pending, /LandXML parsing cancelled/);
  } finally {
    releaseComponent?.();
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
});

it('uses the federated cursor phases without Worker and retains only the near surface in the anchor frame (#5161)', async () => {
  const originalWorker = globalThis.Worker;
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
  const anchor = fixtureModel('anchor') as FederatedModel;
  anchor.loadedAt = 0;
  anchor.geometryResult = {
    meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
      wasmRtcOffset: { x: 0, y: 0, z: 0 },
    },
  };
  useViewerStore.setState({ models: new Map([[anchor.id, anchor]]) });

  const phases: string[] = [];
  const uploaded: number[] = [];
  const plan = { value: null as FederatedLandXmlStreamingPlan | null };
  try {
    const model = await parseLandXmlViewerModelFromBlobAsync(
      new Blob([NEAR_AND_DISTANT_SURFACES]),
      () => true,
      undefined,
      undefined,
      async (mesh) => { phases.push(`raw:${mesh.expressId}`); await plan.value?.publish(mesh); },
      (preflight, sourceCoordinateInfo, spatialReference) => {
        phases.push('preflight');
        assert.equal(preflight.componentCount, 2, 'one near triangle and one connected distant two-triangle component');
        assert.ok((preflight.frame?.originShift.x ?? 0) > 1_000_000,
          'the direct source preflight selects the distant two-triangle component as dominant');
        plan.value = new FederatedLandXmlStreamingPlan({
          modelId: 'terrain', componentCount: preflight.componentCount, sourceCoordinateInfo, spatialReference,
          registry: new FederationRegistry(),
          resources: { publish: (mesh) => { uploaded.push(mesh.expressId); }, remove: () => {} },
          isCurrent: () => true,
        });
        return true;
      },
      async (component) => { phases.push(`measure:${component.mesh.expressId}`); await plan.value?.measure(component.mesh); },
      () => { phases.push('freeze'); plan.value?.freeze(); },
      async (component) => { phases.push(`admit:${component.mesh.expressId}`); await plan.value?.admit(component); },
      () => { phases.push('freezeAdmission'); plan.value?.freezeAdmission(); },
    );
    plan.value?.complete(model.geometryResult);

    assert.deepEqual(phases, [
      'preflight', 'measure:1', 'measure:2', 'freeze',
      'admit:1', 'admit:2', 'freezeAdmission', 'raw:1', 'raw:2',
    ]);
    assert.deepEqual(uploaded, [1]);
    assert.equal(plan.value?.droppedComponentCount, 1);
    assert.deepEqual(model.geometryResult.meshes.map((mesh) => mesh.expressId), [1]);
    assert.deepEqual(model.geometryResult.meshes[0]?.origin, [0.5, 0, -0.5],
      'the retained near triangle keeps its local anchor-frame origin');
    assert.deepEqual(model.geometryResult.coordinateInfo.originShift, anchor.geometryResult.coordinateInfo.originShift);
  } finally {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: originalWorker });
  }
});
