/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The parked-section chip (#5500, charter #5478 §6): a top-left HUD chip
 * while a cut is parked with the tool closed, naming the cut in the bar's
 * metres, with resume and clear. Asserted on the OUTPUT — the region's DOM,
 * the chip's text, the store after each action — never on the wiring.
 * Mounted alongside the visibility chips so the two stack by order, which
 * is the #5481 "badge over the Solo chip" collision made impossible.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import type { ComponentType } from 'react';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';
import { SectionParkedChip } from './SectionParkedChip.js';

const s = () => useViewerStore.getState();

/** One model over a [0,10] x [-1,3] x [0,8] box with one storey. */
function boundedModel(): FederatedModel {
  const base = fixtureModel('m');
  return {
    ...base,
    geometryResult: {
      meshes: [], totalVertices: 0, totalTriangles: 0,
      coordinateInfo: {
        originShift: { x: 0, y: 0, z: 0 },
        originalBounds: { min: { x: 0, y: -1, z: 0 }, max: { x: 10, y: 3, z: 8 } },
        shiftedBounds: { min: { x: 0, y: -1, z: 0 }, max: { x: 10, y: 3, z: 8 } },
        hasLargeCoordinates: false,
      },
    },
    ifcDataStore: {
      ...base.ifcDataStore,
      spatialHierarchy: { byStorey: new Map([[10, []]]), storeyElevations: new Map([[10, 0]]) },
      entities: { ...base.ifcDataStore!.entities, getName: (id: number) => (id === 10 ? 'Erdgeschoss' : null) },
    },
  } as unknown as FederatedModel;
}

beforeEach(() => {
  window.localStorage.clear();
  const model = boundedModel();
  useViewerStore.setState({
    activeTool: 'select',
    sectionPlane: getDefaultSectionPlane(),
    sectionPickMode: false,
    sectionPickPreview: null,
    models: new Map([[model.id, model]]),
    activeModelId: model.id,
    geometryResult: null,
    ifcDataStore: null,
    levelDisplayMode: 'stacked',
    editEnabled: false,
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const region = (name: string) => document.querySelector<HTMLElement>(`[data-hud-region="${name}"]`)!;
const chip = () => [...region('top-left').querySelectorAll<HTMLElement>('[data-hud-item]')].find((el) => el.querySelector('button[aria-label="Resume the section cut"]'));

/** Open the Section tool on a cardinal cut, then leave it: the cut parks. */
async function parkCut(axis: 'down' | 'front' | 'side' = 'down', position = 55): Promise<void> {
  window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis, position, flipped: false }));
  await act(async () => { s().setActiveTool('section'); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { s().setActiveTool('select'); await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(s().sectionPlane.parked, true, 'leaving the tool parks the cut');
}

describe('parked-section chip (#5500)', () => {
  it('is absent with no parked cut, and while the Section tool is open', async () => {
    render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    assert.equal(chip(), undefined, 'nothing parked, no chip');
    window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis: 'down', position: 55, flipped: false }));
    await act(async () => { s().setActiveTool('section'); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(s().sectionPlane.enabled, true);
    assert.equal(chip(), undefined, 'the tool is open: the bar carries the state, not a chip');
  });

  it('names the parked cut in the bar\'s metres and stacks after the Solo chip by order', async () => {
    // Let the revert oracle mount the previous chip and exercise the changed
    // Solo label, rather than failing before the test starts on a dead import.
    const replacementPath = '../../viewport-ui/hud/VisibilityChips.js';
    const previousPath = '../LevelDisplayIndicator.js';
    const StatusChip: ComponentType = await import(replacementPath)
      .then((module) => module.VisibilityChips)
      .catch(async () => (await import(previousPath)).LevelDisplayIndicator);
    render(<><ViewportHud /><SectionParkedChip /><StatusChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    await parkCut('down', 55);
    // 55 % of Y in [-1, 3] is 1.2 m.
    assert.equal(chip()?.textContent?.trim(), 'Down · 1.20 m');
    act(() => useViewerStore.setState({ levelDisplayMode: 'solo', activeStorey: { modelId: 'm', expressId: 10 } }));
    const items = [...region('top-left').querySelectorAll<HTMLElement>(':scope > [data-hud-item]')];
    assert.equal(items.length, 2, 'Solo chip + parked chip, both HUD items');
    assert.match(items[0].textContent ?? '', /Solo · 1 storey/, 'the visibility chips (order 1) come first');
    assert.equal(items[1], chip(), 'the parked chip (order 2) stacks below it — no badge drawn over the Solo chip');
    assert.equal(document.querySelector('[data-section-badge]'), null, 'the corner badge is gone');
  });

  it('names a face-picked cut by its signed distance along the normal', async () => {
    render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    await act(async () => { s().setActiveTool('section'); await new Promise((r) => setTimeout(r, 0)); });
    act(() => s().setSectionPlaneFromFace([1, 0, 0], [-2.345, 0, 0]));
    const picked = s().sectionPlane.custom!.distance;
    await act(async () => { s().setActiveTool('select'); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(chip()?.textContent?.trim(), `Face · ${picked.toFixed(2)} m`);
  });

  it('names a parked section box by its size, and resume brings the box back (#5513)', async () => {
    render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    await act(async () => { s().setActiveTool('section'); await new Promise((r) => setTimeout(r, 0)); });
    act(() => s().setSectionBox({ min: [0, -1, 0], max: [10, 3, 8] }));
    await act(async () => { s().setActiveTool('select'); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(chip()?.textContent?.trim(), 'Box · 10.0×4.0×8.0 m');
    click(chip()!.querySelector('button[aria-label="Resume the section cut"]')!);
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    assert.equal(s().activeTool, 'section');
    assert.equal(s().sectionPlane.enabled, true);
    assert.deepEqual(s().sectionPlane.box, { min: [0, -1, 0], max: [10, 3, 8] }, 'the box mode restore keeps the box');
    assert.equal(s().sectionPickMode, false, 'a resumed box does not arm the face pick');
  });

  it('resume reopens the Section tool on the same cut', async () => {
    render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    await parkCut('front', 40);
    click(chip()!.querySelector('button[aria-label="Resume the section cut"]')!);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(s().activeTool, 'section');
    assert.equal(s().sectionPlane.enabled, true);
    assert.equal(s().sectionPlane.axis, 'front');
    assert.equal(s().sectionPlane.position, 40);
    assert.equal(chip(), undefined, 'the chip yields to the bar');
    assert.ok(region('top-center').querySelector('[data-tool-bar="section"]'), 'the bar is back');
  });

  it('clear forgets the cut: no chip, nothing enabled, and reopening the tool does not bring it back', async () => {
    render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    await parkCut('down', 55);
    click(chip()!.querySelector('button[aria-label="Clear the parked cut"]')!);
    assert.equal(chip(), undefined);
    assert.equal(s().sectionPlane.parked, false);
    assert.equal(s().sectionPlane.enabled, false);
    assert.equal(window.localStorage.getItem('ifc-lite:section-last-mode'), null, 'the persisted cardinal mode is dropped too');
    await act(async () => { s().setActiveTool('section'); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(s().sectionPlane.enabled, false, 'the cleared cut stays cleared');
  });

  it('falls back to the percentage while no model bounds exist', async () => {
    useViewerStore.setState({ models: new Map(), activeModelId: null });
    render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    await parkCut('side', 42.25);
    assert.equal(chip()?.textContent?.trim(), 'Side · 42.3%');
  });
});
