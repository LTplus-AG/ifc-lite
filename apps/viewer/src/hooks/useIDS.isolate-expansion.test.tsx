/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3338: `installFocusIsolation` (row focus, `focusEntity(..., 'isolate')`)
 * and `installSetIsolation` (the isolate-failed/passed/involved buttons)
 * both call `setIsolatedEntities` with ids an IDS specification's
 * applicability filter matched -- which can be a geometry-less
 * `IfcElementAssembly` the same way a LensPanel/SearchModal.filter rule
 * match can. Found in the same audit that surfaced
 * `useEmbedUrlParams.ts`'s gap (a seventh, differently-named-action
 * channel `check-isolate-expansion-routing.mjs` could not see until it
 * started watching `setIsolatedEntities` too).
 *
 * Both directions, per the fix's own requirement: an assembly id expands to
 * its geometry-bearing parts when a resolver is registered, and both
 * actuators fall back to the raw id when no resolver is registered yet
 * (`cameraCallbacks` defaults to `{}` in `seed()` below).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDSValidationReport } from '@ifc-lite/ids';
import { useViewerStore, type FederatedModel } from '@/store';
import { useIDS } from './useIDS.js';

function model(id: string): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 10,
  } as unknown as FederatedModel;
}

/** One spec, one failing entity (express id 5 -- the "assembly" under test). */
function report(): IDSValidationReport {
  return {
    document: { specifications: [] },
    modelInfo: { modelId: 'A', schemaVersion: 'IFC4', entityCount: 1 },
    timestamp: new Date(0),
    summary: {
      totalSpecifications: 1,
      passedSpecifications: 0,
      failedSpecifications: 1,
      totalEntitiesChecked: 1,
      totalEntitiesPassed: 0,
      totalEntitiesFailed: 1,
      overallPassRate: 0,
    },
    specificationResults: [
      {
        specification: { id: 'spec-1', name: 'Spec 1' },
        status: 'fail',
        applicableCount: 1,
        passedCount: 0,
        failedCount: 1,
        passRate: 0,
        entityResults: [
          { expressId: 5, modelId: 'A', entityType: 'IfcElementAssembly', passed: false, requirementResults: [] },
        ],
      },
    ],
  } as unknown as IDSValidationReport;
}

let api: ReturnType<typeof useIDS> | null = null;
let root: Root | null = null;

function Probe(): null {
  api = useIDS();
  return null;
}

async function seed(): Promise<void> {
  useViewerStore.setState({
    models: new Map([['A', model('A')]]),
    isolatedEntities: null,
    ghostExceptEntities: null,
    hiddenEntities: new Set(),
    pendingColorUpdates: null,
    lensAppliedColors: null,
    idsValidationReport: null,
    idsActiveEntityId: null,
    idsIsolateMode: null,
    idsFocusVisibilityOwned: null,
    idsFocusMode: 'ghost',
    cameraCallbacks: {},
  });
  const container = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(api, 'the probe must be mounted');
  await act(async () => {
    useViewerStore.getState().setIdsValidationReport(report());
  });
}

beforeEach(() => {
  api = null;
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

const isolated = () => {
  const s = useViewerStore.getState().isolatedEntities;
  return s ? [...s].sort((a, b) => a - b) : null;
};

describe('#3338: useIDS isolate actuators route ids through resolveHighlightIds', () => {
  it('installFocusIsolation (row isolate) expands a geometry-less assembly id via the registered resolver', async () => {
    await seed();
    useViewerStore.setState({
      cameraCallbacks: { resolveHighlightIds: (ids) => ids.flatMap((id) => (id === 5 ? [51, 52] : [id])) },
    });

    await act(async () => { api!.focusEntity('A', 5, 'isolate'); });

    assert.deepEqual(
      isolated(),
      [5, 51, 52],
      'the resolved parts are unioned with the raw (pre-resolution) id, matching every other ' +
      'isolation channel -- harmless here since the raw assembly id has no geometry of its own',
    );
  });

  it('installFocusIsolation falls back to the raw id when no resolver is registered', async () => {
    await seed(); // cameraCallbacks: {} -- no resolver at all

    await act(async () => { api!.focusEntity('A', 5, 'isolate'); });

    assert.deepEqual(isolated(), [5], 'with no resolver the raw id is isolated, matching pre-fix behaviour');
  });

  it('installFocusIsolation falls back to the raw id when the resolver returns [] (#3338 follow-up)', async () => {
    // A resolver that runs and resolves to nothing (renderer-initialised-
    // but-geometry-not-loaded, or every id resolving geometry-less) must
    // ALSO fall back to the raw ids, not isolate an empty set -- `??` alone
    // only guards an ABSENT resolver.
    await seed();
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => [] } });

    await act(async () => { api!.focusEntity('A', 5, 'isolate'); });

    assert.deepEqual(isolated(), [5], 'an empty resolver result must fall back to the raw id, not isolate []');
  });

  it('installSetIsolation (isolateFailed) expands a geometry-less assembly id via the registered resolver', async () => {
    await seed();
    useViewerStore.setState({
      cameraCallbacks: { resolveHighlightIds: (ids) => ids.flatMap((id) => (id === 5 ? [51, 52] : [id])) },
    });

    await act(async () => { api!.isolateFailed(); });

    assert.deepEqual(
      isolated(),
      [5, 51, 52],
      'the resolved parts are unioned with the raw (pre-resolution) id, matching every other ' +
      'isolation channel',
    );
  });

  it('installSetIsolation falls back to the raw ids when no resolver is registered', async () => {
    await seed(); // cameraCallbacks: {} -- no resolver at all

    await act(async () => { api!.isolateFailed(); });

    assert.deepEqual(isolated(), [5], 'with no resolver the raw failed id is isolated');
  });

  it('installSetIsolation falls back to the raw ids when the resolver returns [] (#3338 follow-up)', async () => {
    await seed();
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => [] } });

    await act(async () => { api!.isolateFailed(); });

    assert.deepEqual(isolated(), [5], 'an empty resolver result must fall back to the raw ids, not isolate []');
  });
});
