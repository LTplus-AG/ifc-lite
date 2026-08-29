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

  it('installFocusIsolation unions the raw id when the resolver returns null -- geometry still streaming (#3426)', async () => {
    // `null` is "cannot answer yet" (Viewport's geometryRef unset), not
    // "answered: nothing renders" -- the raw-id union is correct here since
    // the isolation self-heals once geometry lands.
    await seed();
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => null } });

    await act(async () => { api!.focusEntity('A', 5, 'isolate'); });

    assert.deepEqual(isolated(), [5], 'a still-streaming resolver falls back to the raw id, matching pre-fix behaviour');
  });

  it('installFocusIsolation leaves the isolation channel untouched when the resolver genuinely resolves to [] (#3426 correction)', async () => {
    // A resolver that has already resolved -- geometry is in -- and found
    // nothing renderable must NOT fall back to isolating the raw id: that
    // id has no mesh either, so isolating it blanks the viewport exactly
    // like isolating `[]` does. #3338's union "fix" converted one empty
    // viewport into a different one for precisely this case.
    await seed();
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => [] } });

    await act(async () => { api!.focusEntity('A', 5, 'isolate'); });

    assert.deepEqual(isolated(), null, 'a resolver that genuinely resolves to [] must leave isolatedEntities exactly as it was');
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

  it('installSetIsolation unions the raw ids when the resolver returns null -- geometry still streaming (#3426)', async () => {
    await seed();
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => null } });

    await act(async () => { api!.isolateFailed(); });

    assert.deepEqual(isolated(), [5], 'a still-streaming resolver falls back to the raw ids, matching pre-fix behaviour');
  });

  it('installSetIsolation leaves the isolation channel untouched when the resolver genuinely resolves to [] (#3426 correction)', async () => {
    await seed();
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => [] } });

    await act(async () => { api!.isolateFailed(); });

    assert.deepEqual(isolated(), null, 'a resolver that genuinely resolves to [] must leave isolatedEntities exactly as it was');
  });
});

/**
 * The regression this PR introduced on top of #3426: a skipped install (the
 * resolver definitively answers "nothing renders") must not let the caller
 * (`isolateFailed`/`isolatePassed`/`isolateInvolved`) go on to press the
 * isolate-mode button and paint spec colours for an isolation that never
 * hit the channel -- and must not do so only for `isolateFailed`'s
 * `isolationScope === 'spec'` branch, which is the one that also calls
 * `setSpecColors`.
 */
describe('isolate actuators gate follow-on mode/colour on whether the install actually happened', () => {
  it('a resolver that answers [] leaves idsIsolateMode null and applies no spec colours', async () => {
    await seed();
    useViewerStore.setState({
      cameraCallbacks: { resolveHighlightIds: () => [] },
      idsIsolationScope: 'spec',
    });
    useViewerStore.getState().setIdsActiveSpecification('spec-1');
    // Baseline: `autoApplyColors` (default on) already painted the
    // whole-report overlay when `seed()` installed the report. `setSpecColors`
    // would call `setPendingColorUpdates` again with a NEW Map -- capture the
    // reference so a same-content-different-object swap still fails the test.
    const colorsBeforeCall = useViewerStore.getState().pendingColorUpdates;
    assert.ok(colorsBeforeCall, 'sanity: the whole-report overlay is already applied');

    await act(async () => { api!.isolateFailed(); });

    assert.equal(isolated(), null, 'the channel must stay untouched');
    assert.equal(useViewerStore.getState().idsIsolateMode, null, 'the isolate button must not read pressed');
    assert.equal(
      useViewerStore.getState().pendingColorUpdates,
      colorsBeforeCall,
      'spec colours must not be (re-)applied for an isolation that was never installed',
    );
  });

  it('a resolver that answers null (not yet resolved) still sets the mode and colours, as before', async () => {
    await seed();
    useViewerStore.setState({
      cameraCallbacks: { resolveHighlightIds: () => null },
      idsIsolationScope: 'spec',
    });
    useViewerStore.getState().setIdsActiveSpecification('spec-1');

    await act(async () => { api!.isolateFailed(); });

    assert.deepEqual(isolated(), [5], 'falls back to the raw id, matching pre-fix behaviour');
    assert.equal(useViewerStore.getState().idsIsolateMode, 'failed');
    assert.ok(useViewerStore.getState().pendingColorUpdates, 'spec colours are applied once the install happens');
  });

  it('a resolver that never answers (no resolver registered) still sets the mode, as before', async () => {
    await seed(); // cameraCallbacks: {} -- no resolver at all
    useViewerStore.setState({ idsIsolationScope: 'spec' });
    useViewerStore.getState().setIdsActiveSpecification('spec-1');

    await act(async () => { api!.isolateFailed(); });

    assert.deepEqual(isolated(), [5]);
    assert.equal(useViewerStore.getState().idsIsolateMode, 'failed');
  });

  it('installSetIsolation(null) -- the clear path -- still sets mode/ownership exactly as before', async () => {
    await seed();
    useViewerStore.setState({ idsIsolationScope: 'spec' });
    useViewerStore.getState().setIdsActiveSpecification('spec-1');
    await act(async () => { api!.isolateFailed(); });
    assert.deepEqual(isolated(), [5], 'sanity: something is isolated before clearing');

    await act(async () => { api!.clearIsolation(); });

    assert.equal(isolated(), null);
    assert.equal(useViewerStore.getState().idsIsolateMode, null);
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null);
  });

  it('a skipped install leaves a row focus\'s ownership record alone -- the channel it describes was never touched', async () => {
    await seed();
    useViewerStore.setState({ idsIsolationScope: 'spec' });
    useViewerStore.getState().setIdsActiveSpecification('spec-1');
    // Establish a row focus's isolation and its ownership record first.
    await act(async () => { api!.focusEntity('A', 5, 'isolate'); });
    const ownedBefore = useViewerStore.getState().idsFocusVisibilityOwned;
    assert.ok(ownedBefore, 'sanity: the row focus owns the channel');

    // Now a set-level action whose resolver definitively answers "nothing
    // renders" -- the channel is left untouched, so the row's ownership
    // record is still an accurate description of what's on screen.
    useViewerStore.setState({ cameraCallbacks: { resolveHighlightIds: () => [] } });
    await act(async () => { api!.isolateFailed(); });

    assert.deepEqual(
      useViewerStore.getState().idsFocusVisibilityOwned,
      ownedBefore,
      'the row focus\'s ownership record must survive a skipped install untouched',
    );
  });
});
