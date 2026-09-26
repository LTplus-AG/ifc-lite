/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section chip (#5500, #5893): a top-left HUD chip while the Section
 * tool is closed and a cut is defined, naming the cut in the bar's metres,
 * with a visibility toggle, resume and clear. Since #5893 the cut is
 * lasting scene state — leaving the Section tool no longer hides it, so the
 * chip's own toggle is the only thing that does (`s().sceneState.section.
 * visible`). Asserted on the OUTPUT — the region's DOM, the chip's text,
 * the store after each action — never on the wiring. Mounted alongside the
 * level-display chip so the two stack by order, which is the #5481 "badge
 * over the Solo chip" collision made impossible.
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
import { LevelDisplayIndicator } from '../LevelDisplayIndicator.js';
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
    sceneState: { ...s().sceneState, section: { visible: true } },
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

/** Open the Section tool on a cardinal cut, then leave it: the cut stays
 *  enabled and visible (#5893) — leaving the tool no longer hides it. */
async function defineCut(axis: 'down' | 'front' | 'side' = 'down', position = 55): Promise<void> {
  window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis, position, flipped: false }));
  await act(async () => { s().setActiveTool('section'); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { s().setActiveTool('select'); await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(s().sectionPlane.enabled, true, 'the cut stays enabled after leaving the tool');
  assert.equal(s().sceneState.section.visible, true, 'the cut stays visible after leaving the tool (#5893)');
}

describe('section chip (#5500, #5893)', () => {
  it('is absent with no cut defined, and while the Section tool is open', async () => {
    render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    assert.equal(chip(), undefined, 'no cut, no chip');
    window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis: 'down', position: 55, flipped: false }));
    await act(async () => { s().setActiveTool('section'); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(s().sectionPlane.enabled, true);
    assert.equal(chip(), undefined, 'the tool is open: the bar carries the state, not a chip');
  });

  it('names the cut in the bar\'s metres and stacks after the Solo chip by order', async () => {
    render(<><ViewportHud /><SectionParkedChip /><LevelDisplayIndicator /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    await defineCut('down', 55);
    // 55 % of Y in [-1, 3] is 1.2 m.
    assert.equal(chip()?.textContent?.trim(), 'Down · 1.20 m');
    act(() => useViewerStore.setState({ levelDisplayMode: 'solo', activeStorey: { modelId: 'm', expressId: 10 } }));
    const items = [...region('top-left').querySelectorAll<HTMLElement>(':scope > [data-hud-item]')];
    assert.equal(items.length, 2, 'Solo chip + section chip, both HUD items');
    assert.match(items[0].textContent ?? '', /Erdgeschoss/, 'the level chip (order 1) comes first');
    assert.equal(items[1], chip(), 'the section chip (order 2) stacks below it — no badge drawn over the Solo chip');
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

  it('names a section box by its size, and resume brings the box back (#5513)', async () => {
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
    await defineCut('front', 40);
    click(chip()!.querySelector('button[aria-label="Resume the section cut"]')!);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(s().activeTool, 'section');
    assert.equal(s().sectionPlane.enabled, true);
    assert.equal(s().sectionPlane.axis, 'front');
    assert.equal(s().sectionPlane.position, 40);
    assert.equal(chip(), undefined, 'the chip yields to the bar');
    assert.ok(region('top-center').querySelector('[data-tool-bar="section"]'), 'the bar is back');
  });

  it('the eye toggle hides the cut without forgetting it, and resume brings it back visible (#5893)', async () => {
    render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    await defineCut('down', 55);
    click(chip()!.querySelector('button[aria-label="Hide the section cut"]')!);
    assert.equal(s().sceneState.section.visible, false, 'hidden by the toggle');
    assert.equal(s().sectionPlane.enabled, true, 'the cut itself is not forgotten');
    assert.equal(s().sectionPlane.parked, true, 'parked mirrors the hide toggle (#5893)');
    assert.ok(chip(), 'the chip stays — it is how the cut comes back');
    click(chip()!.querySelector('button[aria-label="Show the section cut"]')!);
    assert.equal(s().sceneState.section.visible, true);
    assert.equal(s().sectionPlane.parked, false);

    click(chip()!.querySelector('button[aria-label="Hide the section cut"]')!);
    assert.equal(s().sceneState.section.visible, false);
    click(chip()!.querySelector('button[aria-label="Resume the section cut"]')!);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(s().activeTool, 'section', 'resume reopens the tool');
    assert.equal(s().sceneState.section.visible, true, 'resume also un-hides the cut');
  });

  it('switching to another tool (e.g. Measure) keeps the cut enabled, visible, and the chip shown (#5893)', async () => {
    render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    await defineCut('down', 55);
    await act(async () => { s().setActiveTool('measure'); await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(s().sectionPlane.enabled, true);
    assert.equal(s().sceneState.section.visible, true);
    assert.ok(chip(), 'the chip shows while any non-Section tool is open');
  });

  it('clear forgets the cut: no chip, nothing enabled, and reopening the tool does not bring it back', async () => {
    render(<><ViewportHud /><SectionParkedChip /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    await defineCut('down', 55);
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
    await defineCut('side', 42.25);
    assert.equal(chip()?.textContent?.trim(), 'Side · 42.3%');
  });
});
