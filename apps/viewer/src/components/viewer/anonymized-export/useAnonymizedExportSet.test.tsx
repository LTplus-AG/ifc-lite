/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useAnonymizedExportSet` (#2934, "anonymized isolated export"). Real store
 * via `new IfcParser().parseColumnar` over the shared fixture
 * (`anonymized-export-fixture.test-support.ts`), `idOffset: 1_000_000` so
 * hand-rolled `globalId - offset` math would fail every assertion here —
 * only `resolveEntityRef` is exercised (per the viewer AGENTS.md "Selection
 * has two channels" and root AGENTS.md federation rules).
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { useAnonymizedExportSet, type AnonymizedExportSetResult } from './useAnonymizedExportSet.js';
import {
  parseFixtureModel,
  FIXTURE_WALL_A,
  FIXTURE_WALL_B,
  FIXTURE_WALL_C,
  FIXTURE_WINDOW,
  FIXTURE_WALL_TYPE,
  FIXTURE_STOREY_1,
  FIXTURE_BUILDING,
  FIXTURE_SITE,
  FIXTURE_PROJECT,
} from './anonymized-export-fixture.test-support.js';

const ID_OFFSET = 1_000_000;
const globalId = (localId: number): number => localId + ID_OFFSET;

function federatedModel(id: string, ifcDataStore: FederatedModel['ifcDataStore']): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset: ID_OFFSET,
    maxExpressId: 100_000,
  } as FederatedModel;
}

let latest: AnonymizedExportSetResult | null = null;
function Probe({ active }: { active: boolean }) {
  latest = useAnonymizedExportSet(active);
  return null;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  mounted.push({ root, container });
  return container;
}
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}
after(unmountAll);

beforeEach(async () => {
  unmountAll();
  latest = null;
  const store = await parseFixtureModel();
  useViewerStore.setState({
    models: new Map([['m1', federatedModel('m1', store)]]),
    selectedEntity: { modelId: 'm1', expressId: FIXTURE_WINDOW },
    selectedEntityIds: new Set([globalId(FIXTURE_WINDOW)]),
  });
});

describe('useAnonymizedExportSet', () => {
  it('latches the window seed and expands to its host by default; toggling IfcRelVoidsElement off drops the host', () => {
    render(<Probe active={true} />);
    assert.ok(latest?.hasSelection, 'a seed must latch on open');
    assert.deepEqual(latest!.seeds, [FIXTURE_WINDOW]);
    assert.ok(latest!.includedIds.has(FIXTURE_WALL_A), 'the host wall must be reachable with defaults');
    const hostGroup = latest!.related!.groups.find((g) => g.relationship === 'IfcRelVoidsElement' && g.role === 'host');
    assert.deepEqual(hostGroup?.expressIds, [FIXTURE_WALL_A]);

    act(() => { latest!.setOption({ IfcRelVoidsElement: false }); });
    assert.equal(latest!.includedIds.has(FIXTURE_WALL_A), false, 'disabling IfcRelVoidsElement must drop the host');
    assert.equal(
      latest!.related!.groups.some((g) => g.relationship === 'IfcRelVoidsElement'),
      false,
      'no IfcRelVoidsElement group at all once the toggle is off',
    );
  });

  it('typeCategories lists every non-IfcRel class with counts; blocking a class drops its unlocked members regardless of how they were reached', () => {
    render(<Probe active={true} />);
    const byName = new Map(latest!.typeCategories.map((c) => [c.typeName, c]));
    assert.ok(byName.has('IfcWall'), 'the host wall class must be listed');
    assert.ok(byName.has('IfcWindow'), 'the seed class must be listed');
    assert.ok(byName.get('IfcProject')?.locked, 'IfcProject is always included, so its category is locked');
    assert.equal([...byName.keys()].some((n) => n.startsWith('IfcRel')), false, 'relationship entities are not categories');
    assert.equal(byName.get('IfcWall')!.count, 1);

    act(() => { latest!.setTypeExcluded('IfcWall', true); });
    assert.equal(latest!.includedIds.has(FIXTURE_WALL_A), false, 'blocking IfcWall removes the host wall');
    assert.ok(latest!.typeCategories.find((c) => c.typeName === 'IfcWall')?.excluded);
    assert.ok(latest!.includedIds.has(FIXTURE_WINDOW), 'the seed is untouched');

    // Blocking the seed's own class is a no-op for the seed (locked).
    act(() => { latest!.setTypeExcluded('IfcWindow', true); });
    assert.ok(latest!.includedIds.has(FIXTURE_WINDOW));

    act(() => { latest!.setTypeExcluded('IfcWall', false); });
    assert.ok(latest!.includedIds.has(FIXTURE_WALL_A), 'unblocking restores the wall');
  });

  it('excluding a related id removes it from includedIds but leaves the group itself untouched', () => {
    render(<Probe active={true} />);
    assert.ok(latest!.includedIds.has(FIXTURE_WALL_TYPE), 'the wall type is included by default');
    const typeGroupBefore = latest!.related!.groups.find((g) => g.relationship === 'IfcRelDefinesByType');
    assert.deepEqual(typeGroupBefore?.expressIds, [FIXTURE_WALL_TYPE]);

    act(() => { latest!.setExcluded(FIXTURE_WALL_TYPE, true); });
    assert.equal(latest!.includedIds.has(FIXTURE_WALL_TYPE), false, 'excluded id must leave includedIds');
    const typeGroupAfter = latest!.related!.groups.find((g) => g.relationship === 'IfcRelDefinesByType');
    assert.deepEqual(
      typeGroupAfter?.expressIds,
      [FIXTURE_WALL_TYPE],
      'the underlying related group is a report of what WAS reached, not filtered by exclusion',
    );

    act(() => { latest!.setExcluded(FIXTURE_WALL_TYPE, false); });
    assert.ok(latest!.includedIds.has(FIXTURE_WALL_TYPE), 're-including must restore it');
  });

  it('a locked id (a seed) cannot be excluded', () => {
    render(<Probe active={true} />);
    assert.ok(latest!.lockedIds.has(FIXTURE_WINDOW));
    act(() => { latest!.setExcluded(FIXTURE_WINDOW, true); });
    assert.ok(latest!.includedIds.has(FIXTURE_WINDOW), 'a seed must stay included no matter what');
  });

  it('spatial ancestors stay present even with every OTHER relation toggle off', async () => {
    unmountAll();
    latest = null;
    const store = await parseFixtureModel();
    useViewerStore.setState({
      models: new Map([['m1', federatedModel('m1', store)]]),
      selectedEntity: { modelId: 'm1', expressId: FIXTURE_WALL_A },
      selectedEntityIds: new Set([globalId(FIXTURE_WALL_A)]),
    });
    render(<Probe active={true} />);
    act(() => {
      latest!.setOption({
        IfcRelVoidsElement: false,
        IfcRelFillsElement: false,
        IfcRelAggregates: 'none',
        IfcRelNests: 'none',
        IfcRelDefinesByType: false,
        IfcRelAssociatesMaterial: false,
        IfcRelDefinesByProperties: false,
        IfcRelConnectsPathElementsDepth: 0,
      });
    });
    for (const id of [FIXTURE_PROJECT, FIXTURE_SITE, FIXTURE_BUILDING, FIXTURE_STOREY_1]) {
      assert.ok(
        latest!.includedIds.has(id),
        `spatial ancestor #${id} must survive every expansion toggle being off — this dialog never exposes IfcRelContainedInSpatialStructure`,
      );
    }
  });

  it('connect depth 1 from Wall B reaches the structurally-connected Wall C; depth 0 does not', async () => {
    unmountAll();
    latest = null;
    const store = await parseFixtureModel();
    useViewerStore.setState({
      models: new Map([['m1', federatedModel('m1', store)]]),
      selectedEntity: { modelId: 'm1', expressId: FIXTURE_WALL_B },
      selectedEntityIds: new Set([globalId(FIXTURE_WALL_B)]),
    });
    render(<Probe active={true} />);
    assert.equal(latest!.includedIds.has(FIXTURE_WALL_C), false, 'depth 0 (the default) must not reach Wall C');

    act(() => { latest!.setOption({ IfcRelConnectsPathElementsDepth: 1 }); });
    assert.ok(latest!.includedIds.has(FIXTURE_WALL_C), 'depth 1 must reach the structurally-connected Wall C');
  });

  it('reload() re-latches from the CURRENT selectedEntityIds and clears exclusions', () => {
    render(<Probe active={true} />);
    act(() => { latest!.setExcluded(FIXTURE_WALL_TYPE, true); });
    assert.ok(latest!.excludedIds.has(FIXTURE_WALL_TYPE));

    act(() => {
      useViewerStore.setState({
        selectedEntity: { modelId: 'm1', expressId: FIXTURE_WALL_A },
        selectedEntityIds: new Set([globalId(FIXTURE_WALL_A)]),
      });
    });
    // Selection changed underneath the dialog, but seeds stay latched…
    assert.deepEqual(latest!.seeds, [FIXTURE_WINDOW], 'seeds must not silently follow a live selection change');

    act(() => { latest!.reload(); });
    // …until Reload is pressed.
    assert.deepEqual(latest!.seeds, [FIXTURE_WALL_A]);
    assert.equal(latest!.excludedIds.size, 0, 'reload must clear stale exclusions');
  });
});
