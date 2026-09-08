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
 * actuators keep the raw ids when the resolver is absent or answers `[]`
 * (`cameraCallbacks` defaults to `{}` in `seed()` below). `[]` is NOT
 * "geometry is in and nothing renders": the resolver bounds-checks against
 * the type-visibility FILTERED mesh list, so an IfcSpace at the shipped
 * `spaces: false` default answers `[]` as well, and dropping the isolate
 * there would make "Isolate failed" on a space-scoped spec do nothing at all.
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

  it('installFocusIsolation keeps the raw id when the resolver answers [] (#3389)', async () => {
    // A hidden type (spaces ship OFF) and a mesh that has not streamed in yet
    // both look like `[]` here. Skipping the install would make the row's
    // isolate mode do nothing; the raw id costs nothing and starts matching
    // the renderer's whitelist as soon as the mesh is visible.
    await seed();
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => [] } });

    await act(async () => { api!.focusEntity('A', 5, 'isolate'); });

    assert.deepEqual(isolated(), [5], 'an empty resolve must still install the raw id');
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

  it('installSetIsolation(null) still clears the channel -- there is nothing to expand', async () => {
    await seed();
    useViewerStore.setState({
      cameraCallbacks: { resolveHighlightIds: (ids) => ids.flatMap((id) => (id === 5 ? [51, 52] : [id])) },
    });
    await act(async () => { api!.isolateFailed(); });
    assert.deepEqual(isolated(), [5, 51, 52], 'sanity: something is isolated before clearing');

    await act(async () => { api!.clearIsolation(); });

    assert.equal(isolated(), null);
    assert.equal(useViewerStore.getState().idsIsolateMode, null);
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null);
  });
});

/**
 * The follow-on state each actuator sets after installing -- the pressed
 * isolate button and the spec colour overlay -- must stay in step with the
 * channel. Since every resolver answer installs SOMETHING (#3389), an empty
 * resolve is not an exception: the mode and the colours are applied exactly
 * as they are for a resolver that expands.
 */
describe('isolate actuators keep mode and colours in step with the channel', () => {
  it('an empty resolve installs the raw ids and applies the mode and spec colours', async () => {
    await seed();
    useViewerStore.setState({
      cameraCallbacks: { resolveHighlightIds: () => [] },
      idsIsolationScope: 'spec',
    });
    useViewerStore.getState().setIdsActiveSpecification('spec-1');

    await act(async () => { api!.isolateFailed(); });

    assert.deepEqual(isolated(), [5], 'the raw ids are installed');
    assert.equal(useViewerStore.getState().idsIsolateMode, 'failed', 'the isolate button reads pressed');
    assert.ok(useViewerStore.getState().pendingColorUpdates, 'spec colours are applied');
  });

  it('a set-level isolate drops a row focus\'s ownership record -- it replaced the channel', async () => {
    await seed();
    useViewerStore.setState({ idsIsolationScope: 'spec' });
    useViewerStore.getState().setIdsActiveSpecification('spec-1');
    await act(async () => { api!.focusEntity('A', 5, 'isolate'); });
    assert.ok(useViewerStore.getState().idsFocusVisibilityOwned, 'sanity: the row focus owns the channel');

    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => [] } });
    await act(async () => { api!.isolateFailed(); });

    assert.equal(
      useViewerStore.getState().idsFocusVisibilityOwned,
      null,
      'the set-level install replaced the channel, so the row\'s record must not outlive it',
    );
  });

  it('focusEntity(isolate) clears idsIsolateMode whatever the resolver answers', async () => {
    await seed();
    await act(async () => { api!.isolateFailed(); });
    assert.equal(useViewerStore.getState().idsIsolateMode, 'failed', 'sanity: isolate mode reads pressed');

    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => [] } });
    await act(async () => { api!.focusEntity('A', 5, 'isolate'); });

    assert.deepEqual(isolated(), [5], 'the row focus replaced the channel with its own id');
    assert.equal(useViewerStore.getState().idsIsolateMode, null, 'the install happened, so the mode clears');
  });

  it('ghost mode clears idsIsolateMode too -- it also replaces a channel', async () => {
    await seed();
    await act(async () => { api!.isolateFailed(); });
    assert.equal(useViewerStore.getState().idsIsolateMode, 'failed');

    await act(async () => { api!.focusEntity('A', 5, 'ghost'); });

    assert.equal(useViewerStore.getState().idsIsolateMode, null, 'ghosting installs, so the mode clears');
  });
});
