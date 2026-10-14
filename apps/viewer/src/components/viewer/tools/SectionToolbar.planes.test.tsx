/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Several cutting planes on the Section bar (#7545), driven the way a user
 * drives them: the empty state's buttons, the Add plane menu, the chips, the
 * plane menu, rename, keyboard, Undo. Every assertion is on the OUTPUT: the
 * store, the rendered chips, `aria-selected` / `disabled`, never on wiring.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, press, type } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { MAX_SECTION_PLANES, orderedSectionPlanes } from '@/lib/section/section-plane-set';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SectionParkedChip } from './SectionParkedChip.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';

const s = () => useViewerStore.getState();

/** One model over a [0,10] x [-1,3] x [0,8] box, so the Box item has bounds to fit. */
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
  } as unknown as FederatedModel;
}

beforeEach(() => {
  window.localStorage.clear();
  const model = boundedModel();
  useViewerStore.setState({
    activeTool: 'section',
    sectionPlane: getDefaultSectionPlane(),
    inactiveSectionPlanes: [],
    sectionUndo: null,
    sectionPickMode: false,
    sectionPickPreview: null,
    sectionPickTarget: 'replace',
    sceneState: { section: { visible: true }, measurements: { visible: true } },
    models: new Map([[model.id, model]]),
    activeModelId: model.id,
    geometryResult: null,
    ifcDataStore: null,
    drawing2DPanelVisible: false,
    drawing2D: null,
    floatingPanels: [],
    poppedOutIds: [],
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
});
afterEach(() => cleanup());

const renderTool = () => render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot><SectionParkedChip /></>);

function bar(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-hud-region="top-center"] [data-tool-bar="section"]');
  assert.ok(el, 'the Section bar is a top-center HUD item');
  return el;
}
const chips = () => [...bar().querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const chipNames = () => chips().map((c) => c.textContent?.trim());
const selectedChip = () => chips().find((c) => c.getAttribute('aria-selected') === 'true');
const hint = () => document.querySelector('[data-hud-region="bottom-center"]')?.textContent ?? '';

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const el = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(el, `no "${text}" button`);
  return el;
}

/** Radix opens a dropdown on pointerdown; its menu portals to the body. */
function openMenu(trigger: Element): HTMLElement[] {
  act(() => {
    trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  });
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')];
}
function menuItem(label: string): HTMLElement {
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')]
    .find((i) => i.textContent?.trim() === label);
  assert.ok(item, `no "${label}" menu item`);
  return item;
}
const addPlane = (label: string) => {
  openMenu(bar().querySelector('[data-testid="section-add-plane"]')!);
  click(menuItem(label));
};
const openPlaneMenu = () => openMenu(bar().querySelector('[data-testid="section-plane-menu"]')!);

describe('with no plane yet (#7545)', () => {
  it('shows the four ways to add one instead of a row of controls, and says what to do', () => {
    renderTool();
    assert.equal(chips().length, 0);
    assert.equal(bar().querySelector('[data-testid="section-active-row"]'), null, 'no row of controls without a plane');
    const empty = bar().querySelector<HTMLElement>('[data-testid="section-empty-add"]');
    assert.ok(empty);
    assert.deepEqual(
      [...empty.querySelectorAll('button')].map((b) => b.textContent?.trim()),
      ['Down (Z)', 'Front (Y)', 'Side (X)', 'Face…'],
    );
    assert.match(hint(), /Add a plane to start cutting/);
    assert.equal(s().sectionPickMode, false, 'nothing is armed behind the user');
  });

  it('a button adds plane A, cutting; the chip, the row of controls and the hint follow', () => {
    renderTool();
    click(buttonByText(bar(), 'Front (Y)'));
    assert.deepEqual(chipNames(), ['A']);
    assert.equal(s().sectionPlane.axis, 'front');
    assert.equal(s().sectionPlane.enabled, true);
    assert.ok(bar().querySelector('[data-testid="section-active-row"]'));
    assert.equal(bar().querySelector('[data-testid="section-empty-add"]'), null);
    assert.doesNotMatch(hint(), /Add a plane to start/);
  });

  it('Face… arms a pick that adds the first plane', () => {
    renderTool();
    click(buttonByText(bar(), 'Face…'));
    assert.equal(s().sectionPickMode, true);
    assert.match(hint(), /Click a face to cut through it/);
    act(() => s().setSectionPlaneFromFace([1, 0, 0], [2, 1, 1]));
    assert.deepEqual(chipNames(), ['A']);
    assert.ok(s().sectionPlane.custom);
  });
});

describe('adding, choosing and removing planes (#7545)', () => {
  it('Add plane never replaces: A, B and C coexist and each chip is a tab for its own plane', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Side (X)');
    addPlane('Front (Y)');
    assert.deepEqual(chipNames(), ['A', 'B', 'C']);
    assert.equal(selectedChip()?.textContent?.trim(), 'C', 'the new plane is the selected one');
    assert.deepEqual(orderedSectionPlanes(s().sectionPlane, s().inactiveSectionPlanes).map((p) => p.axis), ['down', 'side', 'front']);
    click(chips()[0]!);
    assert.equal(s().sectionPlane.name, 'A');
    assert.equal(selectedChip()?.textContent?.trim(), 'A');
    assert.deepEqual(chipNames(), ['A', 'B', 'C'], 'choosing a plane does not reorder the chips');
  });

  it('a chip shows whether its plane is cutting or only a preview, and the row of controls follows the selection', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Side (X)');
    act(() => s().setSectionPlaneCutting(s().sectionPlane.id, false));
    assert.match(selectedChip()!.title, /preview, not cutting/);
    assert.match(chips()[0]!.title, /cutting/);
    const cut = [...bar().querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) => b.textContent?.trim() === 'Cut')!;
    assert.equal(cut.getAttribute('aria-pressed'), 'false', 'Cut belongs to the selected plane');
    click(chips()[0]!);
    assert.equal([...bar().querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) => b.textContent?.trim() === 'Cut')!.getAttribute('aria-pressed'), 'true');
  });

  it('refuses a ninth plane and says why, in text', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    for (let i = 1; i < MAX_SECTION_PLANES; i++) addPlane('Side (X)');
    assert.equal(chips().length, MAX_SECTION_PLANES);
    const add = bar().querySelector<HTMLButtonElement>('[data-testid="section-add-plane"]')!;
    assert.equal(add.disabled, true);
    assert.match(add.title, new RegExp(`At most ${MAX_SECTION_PLANES} planes`));
  });

  it('Box adds a box plane next to the existing cut; Face… arms a pick that adds', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Box');
    assert.ok(s().sectionPlane.box, 'the new plane is the box');
    assert.equal(s().inactiveSectionPlanes.length, 1, 'the Down cut is still there');
    assert.equal(s().inactiveSectionPlanes[0]!.axis, 'down');
    addPlane('Face…');
    assert.equal(s().sectionPickTarget, 'new');
    act(() => s().setSectionPlaneFromFace([0, 0, 1], [1, 1, 3]));
    assert.deepEqual(chipNames(), ['A', 'B', 'C']);
    assert.ok(s().sectionPlane.custom);
  });

  it('the plane menu removes the selected plane, the previous one takes over, and Undo brings it back', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Side (X)');
    openPlaneMenu();
    click(menuItem('Remove'));
    assert.deepEqual(chipNames(), ['A']);
    assert.equal(selectedChip()?.textContent?.trim(), 'A');
    assert.equal(s().sectionUndo?.label, 'removed');
    assert.equal(s().sectionUndo?.name, 'B');
    act(() => s().undoSectionChange());
    assert.deepEqual(chipNames(), ['A', 'B']);
    assert.equal(selectedChip()?.textContent?.trim(), 'B');
  });

  it('Clear all empties the bar back to the add buttons, and Undo restores every plane', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Side (X)');
    openPlaneMenu();
    click(menuItem('Clear all'));
    assert.equal(chips().length, 0);
    assert.ok(bar().querySelector('[data-testid="section-empty-add"]'));
    act(() => s().undoSectionChange());
    assert.deepEqual(chipNames(), ['A', 'B']);
  });

  it('Delete on a focused chip removes its plane', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Side (X)');
    press(chips()[1]!, 'Delete');
    assert.deepEqual(chipNames(), ['A']);
  });

  it('Delete on a chip removes its plane and leaves the focus on the chip that took over', async () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Side (X)');
    act(() => chips()[1]!.focus());
    press(chips()[1]!, 'Delete');
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    assert.deepEqual(chipNames(), ['A']);
    assert.equal(document.activeElement, selectedChip(), 'focus is on the selected chip, not dropped to the page');
  });

  it('arrow keys move the selection AND the focus between chips and wrap, key after key', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Side (X)');
    addPlane('Front (Y)');
    const focused = () => (document.activeElement as HTMLElement | null)?.textContent?.trim();
    act(() => chips()[2]!.focus());
    // Each press goes to whatever holds focus, as the keyboard delivers it: if focus stayed on the
    // old chip, the second press would start from the wrong index.
    const arrow = (key: string) => press(document.activeElement as HTMLElement, key);
    arrow('ArrowRight');
    assert.equal(selectedChip()?.textContent?.trim(), 'A', 'wraps past the last chip');
    assert.equal(focused(), 'A', 'and focus follows');
    arrow('ArrowRight');
    assert.equal(selectedChip()?.textContent?.trim(), 'B');
    assert.equal(focused(), 'B');
    arrow('ArrowLeft');
    arrow('ArrowLeft');
    assert.equal(selectedChip()?.textContent?.trim(), 'C', 'wraps the other way');
    assert.equal(focused(), 'C');
  });
});

describe('naming a plane (#7545)', () => {
  it('double-clicking a chip renames it in place; Enter commits, a clash gets a suffix, Escape cancels', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Side (X)');
    const rename = (to: string | null) => {
      act(() => { chips()[1]!.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
      const input = bar().querySelector<HTMLInputElement>('input[aria-label="Plane name"]')!;
      assert.ok(input, 'the chip turned into a name field');
      if (to === null) { press(input, 'Escape'); return; }
      type(input, to);
      press(input, 'Enter');
    };
    rename('East wing');
    assert.deepEqual(chipNames(), ['A', 'East wing']);
    rename('a');
    assert.deepEqual(chipNames(), ['A', 'a 2'], 'a name already taken (case-insensitively) gets a suffix');
    rename(null);
    assert.deepEqual(chipNames(), ['A', 'a 2'], 'Escape keeps the name');
  });

  it('F2 on a chip opens the name field', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    press(chips()[0]!, 'F2');
    assert.ok(bar().querySelector('input[aria-label="Plane name"]'));
  });
});

describe('the plane menu (#7545)', () => {
  it('turns cutting and the plane\'s own quad on and off for the selected plane', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    assert.equal(openMenu(bar().querySelector('[data-testid="section-plane-menu"]')!).length > 0, true);
    click(menuItem('Cut'));
    assert.equal(s().sectionPlane.enabled, false);
    openPlaneMenu();
    click(menuItem('Show plane'));
    assert.equal(s().sectionPlane.showGizmo, false);
    assert.equal(s().sectionPlane.enabled, false, 'hiding the quad does not touch cutting');
  });

  it('Direction changes what the selected plane is, keeping its name and place; Face… re-picks it instead of adding', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Side (X)');
    const side = s().sectionPlane.id;
    openPlaneMenu();
    assert.equal(menuItem('Side (X)').getAttribute('aria-checked'), 'true', 'the plane\'s current direction is marked');
    click(menuItem('Front (Y)'));
    assert.equal(s().sectionPlane.id, side, 'same plane');
    assert.equal(s().sectionPlane.axis, 'front');
    assert.deepEqual(chipNames(), ['A', 'B'], 'name and order are untouched');

    openPlaneMenu();
    assert.equal(menuItem('Front (Y)').getAttribute('aria-checked'), 'true');
    click(menuItem('Face…'));
    assert.equal(s().sectionPickMode, true);
    assert.equal(s().sectionPickTarget, 'replace', 'the pick replaces this plane; it does not add one');
    act(() => s().setSectionPlaneFromFace([1, 0, 0], [4, 1, 1]));
    assert.deepEqual(chipNames(), ['A', 'B']);
    assert.ok(s().sectionPlane.custom, 'the plane is now the picked face');

    openPlaneMenu();
    assert.equal(menuItem('Front (Y)').getAttribute('aria-checked'), 'false', 'no cardinal direction is marked for a face plane');
    click(menuItem('Down (Z)'));
    assert.equal(s().sectionPlane.custom, undefined, 'choosing a direction turns a face plane back into a cardinal one');
    assert.equal(s().sectionPlane.axis, 'down');
  });

  it('Duplicate adds a copy as the selected plane', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    act(() => s().setSectionPlanePosition(30));
    openPlaneMenu();
    click(menuItem('Duplicate'));
    assert.deepEqual(chipNames(), ['A', 'A copy']);
    assert.equal(s().sectionPlane.position, 30);
  });
});

describe('closing the tool keeps the planes (#5893, #7545)', () => {
  it('Close leaves every plane cutting and the parked chip counts them', () => {
    renderTool();
    click(buttonByText(bar(), 'Down (Z)'));
    addPlane('Side (X)');
    click(bar().querySelector('button[title="Close"]')!);
    assert.equal(s().activeTool, 'select');
    assert.equal(s().sectionPlane.enabled, true);
    assert.equal(s().inactiveSectionPlanes[0]!.enabled, true);
    assert.match(document.querySelector('[data-hud-region="top-left"]')?.textContent ?? '', /2 cuts/);
  });
});
