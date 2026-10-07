/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act, useState } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { advance, cleanup, click, render, waitFor } from '@/test/render';
import { resolveProjection } from '@/lib/geo/reproject';
import { GeoreferenceTab } from './GeoreferenceTab';
import { CesiumPlacementGizmo } from './CesiumPlacementGizmo';
import { useCesiumPlacementController } from './useCesiumPlacementController';

// #7060: a one-metre nudge must never add one degree to an angular anchor.
const conversion = { id: 1, sourceCRS: 2, targetCRS: 3,
  eastings: 5, northings: 52, orthogonalHeight: 10,
  xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 } satisfies MapConversion;
const geographic: ProjectedCRS = { id: 3, name: 'EPSG:4326' };
const projected: ProjectedCRS = { id: 3, name: 'EPSG:32632', mapUnitScale: 1 };
const original = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(original, true);
  setGlobalRendererRef({ current: null });
});

function seed(dirty = false) {
  useViewerStore.setState({
    ...fixtureModels(fixtureModel('m')),
    cesiumPlacementEditMode: true, cesiumPlacementDraftModelId: 'm',
    cesiumPlacementDraft: { ...conversion, eastings: conversion.eastings + (dirty ? 1 : 0) },
    mutationViews: new Map([['m', new MutablePropertyView(null, 'm')]]),
    georefMutations: new Map(), editEnabled: true, collabRoomId: null,
    undoStacks: new Map(), redoStacks: new Map(), changeSets: new Map(), activeChangeSetId: null,
  });
  const camera = { projectToScreen: () => ({ x: 50, y: 50 }),
    unprojectToRay: (_x: number, y: number) => ({
      origin: { x: 10, y: -y / 10, z: 0 }, direction: { x: -1, y: 0, z: 0 },
    }) };
  const canvas = { width: 100, height: 100, clientWidth: 100, clientHeight: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  setGlobalRendererRef({ current: { getCamera: () => camera, getCanvas: () => canvas } as unknown as Renderer });
}

// Invoke every controller entry point through a mounted component, even when
// global edit mode is enabled and normal edit controls are hidden.
function Probe({ initialCRS }: { initialCRS?: ProjectedCRS }) {
  const [crs, setCRS] = useState(initialCRS);
  const props = { modelId: 'm', mapConversion: conversion,
    baseMapConversion: conversion, projectedCRS: crs };
  const c = useCesiumPlacementController(props);
  return <>
    <output data-testid="capability">{String(c.canEdit)}</output>
    <button onClick={() => {
      c.beginEditing(); c.nudge(c.nudgeStep, 0); c.nudgeHeight(c.nudgeStep);
      c.nudgeRotation(1); c.updateDraft({ eastings: 77 }); c.handleApply(); c.handleReset();
    }}>Invoke edit actions</button>
    <button onClick={() => setCRS(geographic)}>Switch to geographic</button>
    <button onClick={() => setCRS(projected)}>Switch to projected</button>
    <button onClick={() => setCRS(undefined)}>Remove CRS</button>
    <button onClick={() => setCRS({ id: 3, name: 'unrecognised coordinate system' })}>Unresolved CRS</button>
    <button onClick={() => setCRS({ ...projected, name: 'EPSG:32631' })}>Other projected CRS</button>
    <GeoreferenceTab {...props} />
    <CesiumPlacementGizmo {...props} />
  </>;
}

for (const crs of [geographic, undefined, { id: 3, name: 'unrecognised coordinate system' }]) {
  it(`blocks geographic/unresolved metre editing, including direct actions (${crs?.name ?? 'absent'}, #7060)`, async () => {
    seed(true);
    const ui = render(<Probe initialCRS={crs} />);
    if (crs) await resolveProjection(crs);
    await advance(0);
    const before = useViewerStore.getState().cesiumPlacementDraft;
    assert.equal(ui.querySelector('[data-testid="capability"]')?.textContent, 'false');
    assert.match(ui.textContent ?? '', /requires a projected CRS/);
    assert.equal(ui.querySelector('[aria-label="Drag Eastings and Northings"]'), null);
    assert.equal(ui.querySelector('[aria-label="Nudge east"]'), null);
    click(Array.from(ui.querySelectorAll('button')).find(button => button.textContent === 'Invoke edit actions')!);
    assert.equal(useViewerStore.getState().cesiumPlacementDraft, before,
      'blocked metre actions preserve the existing angular draft');
    assert.equal(useViewerStore.getState().georefMutations.size, 0,
      'blocked apply cannot persist the dirty angular draft');
  });
}

it('preserves projected one-metre nudge/apply and immediately disables on CRS change (#7060)', async () => {
  seed();
  const ui = render(<Probe initialCRS={projected} />);
  await waitFor(() => Boolean(ui.querySelector('[aria-label="Nudge east"]')), 'projected nudge is available');
  assert.ok(ui.querySelector('[aria-label="Drag Eastings and Northings"]'));
  click(ui.querySelector('[aria-label="Nudge east"]')!);
  assert.equal(useViewerStore.getState().cesiumPlacementDraft?.eastings, conversion.eastings + 1);
  click(Array.from(ui.querySelectorAll('button')).find(button => button.textContent?.includes('Set as georeference'))!);
  assert.equal(useViewerStore.getState().getGeorefMutations('m')?.mapConversion?.eastings, conversion.eastings + 1);
  const sourceBefore = useViewerStore.getState().getGeorefMutations('m');
  const draftBefore = useViewerStore.getState().cesiumPlacementDraft;
  click(Array.from(ui.querySelectorAll('button')).find(button => button.textContent === 'Switch to geographic')!);
  assert.equal(ui.querySelector('[data-testid="capability"]')?.textContent, 'false',
    'previous projected capability expires during render before resolution');
  assert.equal(ui.querySelector('[aria-label="Drag Eastings and Northings"]'), null);
  click(Array.from(ui.querySelectorAll('button')).find(button => button.textContent === 'Invoke edit actions')!);
  assert.equal(useViewerStore.getState().cesiumPlacementDraft, draftBefore);
  assert.equal(useViewerStore.getState().getGeorefMutations('m'), sourceBefore);
  await advance(0);
});


it('abandons a captured gesture when geographic capability aborts editing (#7060)', async () => {
  seed();
  const ui = render(<Probe initialCRS={projected} />);
  const heightHandle = () => ui.querySelector('[aria-label="Drag OrthogonalHeight"]');
  await waitFor(() => Boolean(heightHandle()), 'projected height handle is available');
  const pointer = (type: string, clientY: number) => new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, clientX: 50, clientY,
  });
  act(() => heightHandle()!.dispatchEvent(pointer('pointerdown', 50)));
  click(Array.from(ui.querySelectorAll('button')).find(button => button.textContent === 'Switch to geographic')!);
  await waitFor(() => !useViewerStore.getState().cesiumPlacementEditMode, 'geographic session aborts');
  click(Array.from(ui.querySelectorAll('button')).find(button => button.textContent === 'Switch to projected')!);
  await waitFor(() => ui.querySelector('[data-testid="capability"]')?.textContent === 'true', 'projected capability resolves again');
  click(ui.querySelector('[role="switch"]')!);
  await waitFor(() => Boolean(heightHandle()), 'new projected session has a height handle');
  const draftBefore = useViewerStore.getState().cesiumPlacementDraft;
  act(() => heightHandle()!.dispatchEvent(pointer('pointermove', 30)));
  assert.equal(useViewerStore.getState().cesiumPlacementDraft, draftBefore,
    'hovering the new handle cannot resume the old captured drag');
});


for (const action of ['Remove CRS', 'Unresolved CRS']) {
  it(`aborts a dirty projected session after ${action} without reviving its draft (#7060)`, async () => {
    seed(true);
    const ui = render(<Probe initialCRS={projected} />);
    await waitFor(() => Boolean(ui.querySelector('[aria-label="Nudge east"]')), 'dirty projected session is ready');
    assert.match(ui.textContent ?? '', /6\.00 m/);
    click(Array.from(ui.querySelectorAll('button')).find(button => button.textContent === action)!);
    await waitFor(() => !useViewerStore.getState().cesiumPlacementEditMode, 'unavailable CRS aborts editing');
    click(Array.from(ui.querySelectorAll('button')).find(button => button.textContent === 'Switch to projected')!);
    await waitFor(() => ui.querySelector('[data-testid="capability"]')?.textContent === 'true', 'projected CRS returns');
    assert.equal(ui.querySelector('[aria-label="Nudge east"]'), null, 'the aborted session does not revive');
    click(ui.querySelector('[role="switch"]')!);
    await waitFor(() => Boolean(ui.querySelector('[aria-label="Nudge east"]')), 'a fresh edit session is available');
    assert.match(ui.textContent ?? '', /5\.00 m/, 'new session displays the saved anchor');
    assert.doesNotMatch(ui.textContent ?? '', /6\.00 m/, 'old draft does not shadow the saved anchor');
    assert.equal(useViewerStore.getState().georefMutations.size, 0, 'aborting does not persist source edits');
  });
}

it('preserves an active dirty draft while another valid projected CRS is pending (#7060)', async () => {
  seed(true);
  const ui = render(<Probe initialCRS={projected} />);
  await waitFor(() => Boolean(ui.querySelector('[aria-label="Nudge east"]')), 'first projected CRS is ready');
  const before = useViewerStore.getState().cesiumPlacementDraft;
  click(Array.from(ui.querySelectorAll('button')).find(button => button.textContent === 'Other projected CRS')!);
  assert.equal(ui.querySelector('[data-testid="capability"]')?.textContent, 'false', 'new classification is pending');
  assert.equal(useViewerStore.getState().cesiumPlacementDraft, before, 'pending classification preserves the active draft');
  await waitFor(() => Boolean(ui.querySelector('[aria-label="Nudge east"]')), 'second projected CRS is ready');
  assert.match(ui.textContent ?? '', /6\.00 m/, 'resolved projected controls retain the live preview');
  assert.equal(useViewerStore.getState().cesiumPlacementDraft, before);
});
