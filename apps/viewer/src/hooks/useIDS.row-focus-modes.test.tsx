/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-row focus modes for IDS results (#2867), mirroring the clash panel.
 *
 * Activating an IDS result row used to do three things — set the active
 * entity, set the store selection, and frame it. In a large model that is not
 * enough to FIND the element: it keeps the same report red/green as every
 * other failing element around it, and nothing hides or fades the context.
 *
 * The clash panel already solved exactly this shape (`focusClash`, #1275): a
 * persistent `highlight` / `isolate` / `ghost` mode, a distinct colour pushed
 * through the colour-override channel, and an ownership record so the shared
 * visibility channels can be released without stepping on another feature.
 * This file drives the IDS equivalent through the REAL `useIDS()` hook and the
 * REAL store — including the two-way handoff with clash, which shares those
 * channels.
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
import { releaseOwnedClashVisibility } from '@/lib/clash/visibility-ownership.js';

// ─── Fixture ────────────────────────────────────────────────────────────────

/** Two models, both with `idOffset: 0`, so a global id equals its express id.
 *  That keeps the assertions about the visibility channels readable — what is
 *  under test here is ownership and mode, not id arithmetic (covered by
 *  `useClash.federated-id-offset.test.tsx`). */
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

/** One specification, two failing entities (1, 2) and one passing (3). */
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

// ─── Harness ────────────────────────────────────────────────────────────────

type Api = { ids: ReturnType<typeof useIDS>; clash: ReturnType<typeof useClash> };

let api: Api | null = null;
let root: Root | null = null;

function Probe(): null {
  api = { ids: useIDS(), clash: useClash() };
  return null;
}

async function seed(withReport = true): Promise<void> {
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
  if (withReport) {
    await act(async () => {
      useViewerStore.getState().setIdsValidationReport(report());
    });
  }
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

// ─── The three modes ────────────────────────────────────────────────────────

describe('IDS per-row focus modes (#2867)', () => {
  it('isolate: activating a row hides everything except that element, and IDS records the claim', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });

    assert.deepEqual(isolated(), [1], 'isolate mode must isolate exactly the activated element');
    assert.equal(ghosted(), null, 'isolation and ghosting are mutually exclusive channels');
    const owned = useViewerStore.getState().idsFocusVisibilityOwned;
    assert.ok(owned, 'IDS must record what it installed, so it can release only that');
    assert.equal(owned.channel, 'isolate');
    assert.deepEqual([...owned.ids], [1]);
  });

  it('ghost: the element stays solid and the rest fades to context', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'ghost'); });

    assert.deepEqual(ghosted(), [1], 'ghost mode keeps the activated element solid and fades the rest');
    assert.equal(isolated(), null);
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned?.channel, 'ghost');
  });

  it('highlight: neither channel is touched, and IDS claims neither', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'highlight'); });

    assert.equal(isolated(), null, 'highlight shows the element in the whole model');
    assert.equal(ghosted(), null);
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null,
      'owning nothing is the fact a later release must read — inferring ownership from "a row is active" over-clears');
    assert.deepEqual(useViewerStore.getState().idsActiveEntityId, { modelId: 'A', expressId: 1 },
      'a row IS active — the fact an ownership inference would have mistaken for a claim');
  });

  it('the activated element is painted a colour its failing neighbours do not share', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'highlight'); });

    const colors = useViewerStore.getState().pendingColorUpdates;
    assert.ok(colors, 'the focus must reach the colour-override channel');
    assert.deepEqual(colors.get(1), IDS_FOCUS_COLOR,
      'the activated row is the one the user is hunting for — it cannot wear the same red as every other failure');
    assert.notDeepEqual(colors.get(2), IDS_FOCUS_COLOR,
      'and its equally-failing neighbour must keep the report colour, or the focus colour says nothing');
    assert.ok(colors.get(2), 'the rest of the report stays coloured — the focus adds to it, it does not replace it');
  });
});

// ─── Switching rows and modes ───────────────────────────────────────────────

describe('IDS row focus releases its own previous presentation', () => {
  it('switching ROWS isolates only the new row, never the union', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    await act(async () => { api!.ids.focusEntity('A', 2, 'isolate'); });

    assert.deepEqual(isolated(), [2], 'the previous row must not accumulate');
    const colors = useViewerStore.getState().pendingColorUpdates;
    assert.deepEqual(colors?.get(2), IDS_FOCUS_COLOR, 'the new row wears the focus colour');
    assert.notDeepEqual(colors?.get(1), IDS_FOCUS_COLOR, 'and the previous row gives it back');
  });

  it('switching MODES on the same row moves the claim to the other channel', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    await act(async () => { api!.ids.focusEntity('A', 1, 'ghost'); });

    assert.equal(isolated(), null, 'the isolation the previous mode installed must go');
    assert.deepEqual(ghosted(), [1]);
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned?.channel, 'ghost');
  });

  it('switching to HIGHLIGHT releases the isolation the row focus itself installed', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    await act(async () => { api!.ids.focusEntity('A', 1, 'highlight'); });

    assert.equal(isolated(), null,
      'an isolation left standing after the user asked for full context hides the model with no way to tell why');
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null);
  });

  it('clearing the row selection releases the row focus presentation', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    await act(async () => { api!.ids.clearEntitySelection(); });

    assert.equal(isolated(), null, 'deactivating the row must not leave the model isolated on it');
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null);
  });

  it('ownership is CONTENT: a later owner of the same channel is not released by IDS', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'ghost'); });
    assert.deepEqual(ghosted(), [1], 'setup sanity: IDS owns the ghost channel');

    // Another feature (the spaces X-ray, LayerDiffView, Space Sketch) takes the
    // SAME channel over. Deliberately a SUPERSET of what IDS installed: a
    // subset test, or "is my record's channel non-empty", both answer "still
    // mine" here and destroy this owner's ghost. Only equal MEMBERS mean it is
    // still the IDS row focus on screen.
    await act(async () => { useViewerStore.getState().setGhostExceptEntities(new Set([1, 9])); });

    await act(async () => { api!.ids.clearEntitySelection(); });

    assert.deepEqual(ghosted(), [1, 9],
      "IDS installed {1}, the channel shows {1, 9} — that is somebody else's presentation and must survive");
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null,
      'IDS still drops its own stale claim');
  });

  it('a NEW report landing ends the row focus built from the old one', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });

    // A re-run publishes a fresh report. The focused row belonged to the
    // previous one, and its express ids need not denote the same entities.
    await act(async () => { useViewerStore.getState().setIdsValidationReport(report()); });

    assert.equal(isolated(), null,
      'an isolation built from the superseded report must not survive the report that replaced it');
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null);
  });

  it('clearing the report releases the row focus presentation (no stranded blank viewport)', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    await act(async () => { api!.ids.clearValidation(); });

    assert.equal(isolated(), null,
      'the report is gone; an isolation built from it left standing makes isEntityVisible false for everything');
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null,
      'and the claim must not outlive the presentation — a stale record re-matches as soon as another owner installs equal content');
  });
});

describe('IDS row focus and IDS set-level isolation are one presentation at a time', () => {
  it("a row focus that takes the channel clears the isolate buttons' pressed state", async () => {
    await seed();
    await act(async () => { api!.ids.isolateFailed(); });
    assert.deepEqual(isolated(), [1, 2], 'setup sanity: the set-level isolation is showing');
    assert.equal(useViewerStore.getState().idsIsolateMode, 'failed');

    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });

    assert.deepEqual(isolated(), [1], 'the row focus replaced the set isolation on screen');
    assert.equal(useViewerStore.getState().idsIsolateMode, null,
      'so the isolate-failed button must stop reading as pressed — it describes an isolation that is no longer there');
  });

  it('a set-level isolate taking the channel back drops the row focus claim', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    await act(async () => { api!.ids.isolateFailed(); });

    assert.deepEqual(isolated(), [1, 2], 'setup sanity: the set isolation replaced the row focus');
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null,
      'the row focus no longer owns anything — a record left behind re-matches as soon as another owner installs equal content');
  });

  it('show-all ends a row GHOST as well, claim included', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'ghost'); });
    await act(async () => { api!.ids.clearIsolation(); });

    // `setIsolatedEntities(null)` nulls `ghostExceptEntities` too — the two
    // channels are mutually exclusive (visibilitySlice) — so "show all" really
    // does show all, and the claim goes with it.
    assert.equal(ghosted(), null, 'a row ghost must not survive the button that says "show all"');
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null,
      'and the claim must not outlive it');
  });
});

// ─── The two-way handoff with clash ─────────────────────────────────────────

describe('IDS and clash share the visibility channels — neither may strand the other', () => {
  it('IDS → CLASH: clash taking the channel over survives an IDS row-focus release', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    // Clash takes the channel over with its own content.
    await act(async () => { api!.clash.focusClash(CLASH, 'ghost'); });
    assert.deepEqual(ghosted(), [5, 6], 'setup sanity: clash owns the ghost channel now');

    // The IDS row is deactivated. Its record still names `isolate`, but the
    // channel no longer shows what IDS installed.
    await act(async () => { api!.ids.clearEntitySelection(); });

    assert.deepEqual(ghosted(), [5, 6],
      "IDS must release only what IDS installed — clearing by feature rather than by content destroys clash's ghost");
    assert.equal(useViewerStore.getState().clashVisibilityOwned?.channel, 'ghost',
      "and clash's own claim must be left intact");
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null,
      'IDS still drops its own (now stale) claim — a record that outlives its presentation re-matches later');
  });

  it('CLASH → IDS: an IDS row focus survives clash\'s ownership-scoped release', async () => {
    await seed();
    await act(async () => { api!.clash.focusClash(CLASH, 'ghost'); });
    // IDS takes the channel over with its own content.
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    assert.deepEqual(isolated(), [1], 'setup sanity: IDS owns the isolate channel now');
    assert.equal(useViewerStore.getState().clashVisibilityOwned?.channel, 'ghost',
      "setup sanity: clash's record is now stale — its ghost was replaced");

    // `releaseOwnedClashVisibility` is the ONE predicate every ownership-scoped
    // clash release routes through — the run-start release
    // (`useClash.discardSolidPresentation`) and every model-lifecycle teardown
    // (`endClashScenePresentation`). Driven directly because a `run()` needs
    // real meshed geometry; the predicate is what both paths actually ask.
    //
    // NOT `clearHighlight()`: that is the panel's "Clear selection, isolation
    // and ghosting" button, which clears both channels outright BY DESIGN and
    // is a user asking for exactly that — see its body in `useClash`.
    await act(async () => { releaseOwnedClashVisibility(useViewerStore.getState()); });

    assert.deepEqual(isolated(), [1],
      "clash releases only what clash installed — the IDS row focus is a different owner's presentation");
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned?.channel, 'isolate',
      "and IDS's claim must be left intact");
    assert.equal(useViewerStore.getState().clashVisibilityOwned, null,
      'clash still drops its own stale claim');
  });

  it('a model removal releases the IDS row focus rather than stranding it', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });

    await act(async () => { useViewerStore.getState().removeModel('B'); });

    assert.equal(isolated(), null,
      'an IDS-owned isolation surviving a model removal is a blank viewport with nothing selected');
    assert.equal(useViewerStore.getState().idsFocusVisibilityOwned, null);
  });

  it('a model removal does NOT release a channel IDS does not own', async () => {
    await seed();
    await act(async () => { api!.ids.focusEntity('A', 1, 'isolate'); });
    // Another feature (the spaces X-ray, LayerDiffView, Space Sketch) takes over.
    await act(async () => { useViewerStore.getState().setGhostExceptEntities(new Set([9])); });

    await act(async () => { useViewerStore.getState().removeModel('B'); });

    assert.deepEqual(ghosted(), [9],
      "IDS never installed this ghost — releasing it would destroy the next owner's presentation (#2654)");
  });
});
