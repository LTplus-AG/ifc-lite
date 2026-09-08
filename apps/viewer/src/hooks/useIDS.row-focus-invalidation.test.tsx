/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A visibility-ownership record must not outlive its presentation — from
 * EITHER side of the shared channel (review of #2867).
 *
 * `#2867` closed the stale-record hole only where IDS itself acts
 * (`installSetIsolation` nulls `idsFocusVisibilityOwned`). Nothing did the
 * equivalent when ANY OTHER owner replaced the channel, and ownership is
 * tested by VALUE: a record that survives its presentation goes matching →
 * cleared → MATCHING AGAIN as soon as the next owner installs a set with equal
 * content, and the next release then destroys THAT owner's presentation. That
 * is #2654, reopened, on the IDS side — and symmetrically on the clash side,
 * where an IDS row focus supersedes a clash ghost.
 *
 * The fix is not per-caller: it is the shared invalidation the two slice
 * setters that REPLACE these channels now perform (`visibilitySlice`), which
 * drops every record the new channel content no longer matches. This file
 * drives it through the REAL hooks and the REAL store.
 *
 * It also covers the two channels the row focus writes but the release sites
 * did not both hand back: the PAINT channel (`pendingColorUpdates`), and the
 * panel's "Clear isolation (show all)" affordance, which read only the
 * isolate channel while the DEFAULT mode writes the ghost one.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDSValidationReport } from '@ifc-lite/ids';
import type { Clash } from '@ifc-lite/clash';
import { useViewerStore, type FederatedModel } from '@/store';
import { useIDS } from './useIDS.js';
import { useClash } from './useClash.js';
import { IDS_FOCUS_COLOR } from './ids/idsColorSystem.js';

// ─── Fixture (same shape as `useIDS.row-focus-modes.test.tsx`) ──────────────

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

function report(): IDSValidationReport {
  const entity = (expressId: number, passed: boolean) => ({
    expressId,
    modelId: 'A',
    entityType: 'IfcWall',
    passed,
    requirementResults: [],
  });
  return {
    document: { specifications: [] },
    modelInfo: { modelId: 'A', schemaVersion: 'IFC4', entityCount: 3 },
    timestamp: new Date(0),
    summary: {
      totalSpecifications: 1,
      passedSpecifications: 0,
      failedSpecifications: 1,
      totalEntitiesChecked: 3,
      totalEntitiesPassed: 1,
      totalEntitiesFailed: 2,
      overallPassRate: 33,
    },
    specificationResults: [
      {
        specification: { id: 'spec-1', name: 'Spec 1' },
        status: 'fail',
        applicableCount: 3,
        passedCount: 1,
        failedCount: 2,
        passRate: 33,
        entityResults: [entity(1, false), entity(2, false), entity(3, true)],
      },
    ],
  } as unknown as IDSValidationReport;
}

const CLASH: Clash = {
  id: 'clash-1',
  a: { key: 'A:5', ref: 5, model: 'A', tag: 'IfcWall' },
  b: { key: 'A:6', ref: 6, model: 'A', tag: 'IfcWall' },
  rule: 'all-clashes',
  status: 'hard',
  distance: -0.5,
  point: [0.75, 0.5, 0.5],
  bounds: { min: [0.5, 0, 0], max: [1, 1, 1] },
  severity: 'major',
};

type Api = { ids: ReturnType<typeof useIDS>; clash: ReturnType<typeof useClash> };

let api: Api | null = null;
let root: Root | null = null;

function Probe(): null {
  api = { ids: useIDS(), clash: useClash() };
  return null;
}

async function seed(): Promise<void> {
  useViewerStore.setState({
    models: new Map([['A', model('A')], ['B', model('B')]]),
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
    clashVisibilityOwned: null,
    clashSelectedId: null,
    clashHighlightColors: null,
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
const ghosted = () => {
  const s = useViewerStore.getState().ghostExceptEntities;
  return s ? [...s].sort((a, b) => a - b) : null;
};

// ─── D1 / D2 / D3: a record dropped when another owner takes the channel ────

describe('an ownership record dies with its presentation, whoever replaced it', () => {
  it('D1: an IDS claim superseded by CLASH does not later destroy the user\'s own isolation', async () => {
    await seed();
    // 1. IDS row focus isolates element 1 and records `{isolate, {1}}`.
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    // 2. Clash takes the channel over. The IDS presentation is GONE from the
    //    screen — `setGhostExceptEntities` nulls `isolatedEntities`.
    await act(async () => { api!.clash.focusClash(CLASH, 'ghost'); });
    assert.deepEqual(isolated(), null, 'setup: the IDS isolation is off screen');
    assert.equal(
      useViewerStore.getState().idsFocusVisibilityOwned,
      null,
      'the IDS claim ended when its presentation did — a record that outlives it re-matches later',
    );

    // 3. The user isolates element 1 BY HAND (Isolate in 3D / the model tree).
    //    Equal content to what IDS once installed, and IDS installed none of it.
    await act(async () => { useViewerStore.getState().setIsolatedEntities(new Set([1])); });
    assert.deepEqual(isolated(), [1], 'setup: the user owns the isolate channel now');

    // 4. An unrelated model leaves the federation.
    await act(async () => { useViewerStore.getState().removeModel('B'); });

    assert.deepEqual(
      isolated(),
      [1],
      "the user's own isolation must survive — a stale IDS record matching it by value is #2654 reopened",
    );
  });

  it('D2: clash\'s "clear selection, isolation and ghosting" ends the IDS claim too', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'ghost'); });
    assert.deepEqual(ghosted(), [1], 'setup: IDS owns the ghost channel');

    // The panel button that clears both channels outright, by design.
    await act(async () => { api!.clash.clearHighlight(); });

    assert.equal(ghosted(), null, 'setup: the ghost is gone (that part is the button working)');
    assert.equal(
      useViewerStore.getState().idsFocusVisibilityOwned,
      null,
      'and the IDS claim went with the presentation — a stranded record destroys the NEXT owner of the same content',
    );

    // The consequence, run out: the next owner installs the same content.
    await act(async () => { useViewerStore.getState().setGhostExceptEntities(new Set([1])); });
    await act(async () => { useViewerStore.getState().removeModel('B'); });
    assert.deepEqual(ghosted(), [1], "the next owner's ghost must survive a model removal IDS has no claim on");
  });

  it('D3 (mirror): an IDS row focus superseding a clash ghost ends the CLASH claim', async () => {
    await seed();
    await act(async () => { api!.clash.focusClash(CLASH, 'ghost'); });
    assert.deepEqual(ghosted(), [5, 6], 'setup: clash owns the ghost channel');

    // IDS takes the channel over: `setIsolatedEntities` nulls the ghosting.
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    assert.equal(ghosted(), null, 'setup: the clash ghost is off screen');
    assert.equal(
      useViewerStore.getState().clashVisibilityOwned,
      null,
      'the clash claim must end with its presentation — the rule is symmetric or it is not a rule',
    );

    // The consequence: another owner installs a ghost with the SAME content.
    await act(async () => { useViewerStore.getState().setGhostExceptEntities(new Set([5, 6])); });
    await act(async () => { useViewerStore.getState().removeModel('B'); });
    assert.deepEqual(ghosted(), [5, 6], "the next owner's ghost must survive — clash no longer has a claim on it");
  });

  it('a record whose content is REPLAYED intact survives — invalidation is by content, not by "somebody wrote"', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });

    // Space Sketch's open/close view capture and `syncSourceModel` both rebuild
    // an unchanged channel through the cloning setters (#2662 P2). Equal
    // members mean the IDS row focus is still exactly what is on screen.
    await act(async () => { useViewerStore.getState().setIsolatedEntities(new Set([1])); });

    assert.equal(
      useViewerStore.getState().idsFocusVisibilityOwned?.channel,
      'isolate',
      'a content-preserving rewrite must not convert a feature-owned focus into "user" state',
    );
    await act(async () => { api!.ids.clearEntitySelection(); });
    assert.equal(isolated(), null, 'and the release must still work through it');
  });
});

// ─── D4: the clear affordance must see BOTH channels ────────────────────────

describe('the "Clear isolation (show all)" affordance follows the presentation, not one channel', () => {
  it('D4: a row focus in the DEFAULT ghost mode leaves the clear action enabled', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'ghost'); });

    assert.deepEqual(ghosted(), [1], 'setup: the model is faded around element 1');
    assert.equal(isolated(), null, 'setup: ghosting and isolation are mutually exclusive');
    assert.equal(
      api!.ids.visibilityFilterActive,
      true,
      'the whole model is faded and the panel greys out its only way back — the default mode makes it dead',
    );
  });

  it('and it is disabled when neither channel is showing anything', async () => {
    await seed();
    assert.equal(api!.ids.visibilityFilterActive, false, 'nothing is isolated or ghosted — nothing to clear');
  });

  it('clearing really does clear the ghost the default mode installed', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'ghost'); });
    await act(async () => { api!.ids.clearIsolation(); });
    assert.equal(ghosted(), null);
    assert.equal(api!.ids.visibilityFilterActive, false);
  });
});

// ─── D5: the PAINT channel is released where visibility is ──────────────────

describe('the row focus tint is handed back wherever the row focus is released', () => {
  it('D5: a model removal does not leave a focus marker painted for a row that is gone', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    assert.deepEqual(
      useViewerStore.getState().pendingColorUpdates?.get(1),
      IDS_FOCUS_COLOR,
      'setup: the row wears the focus colour',
    );

    await act(async () => { useViewerStore.getState().removeModel('B'); });

    assert.notDeepEqual(
      useViewerStore.getState().pendingColorUpdates?.get(1),
      IDS_FOCUS_COLOR,
      'the row focus was released on the visibility channel but left painted — a cyan marker for a focus that ended',
    );
  });

  it('D5: clearing the report does not leave a focus marker painted for a row that no longer exists', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });

    await act(async () => { useViewerStore.getState().clearIdsValidationReport(); });

    assert.notDeepEqual(
      useViewerStore.getState().pendingColorUpdates?.get(1),
      IDS_FOCUS_COLOR,
      'the report is gone; the focus tint for one of its rows must not stay on the model',
    );
  });
});
