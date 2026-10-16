/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Views menu on the Section bar (#7545), driven like a user: save the current
 * planes and camera under a name, change everything, apply the saved view.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, press, type } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { saveCurrentSectionCut, useSavedSectionCuts } from '@/store/savedSectionCutsStore';
import { orderedSectionPlanes } from '@/lib/section/section-plane-set';
import type { CameraViewpoint } from '@/store/types';
import { SectionViewsMenu } from './SectionViewsMenu.js';

const state = () => useViewerStore.getState();
const VIEW: CameraViewpoint = { position: { x: 5, y: 6, z: 7 }, target: { x: 1, y: 2, z: 3 }, up: { x: 0, y: 1, z: 0 }, fov: 0.8, projectionMode: 'perspective' };
let applied: CameraViewpoint[] = [];

beforeEach(() => {
  applied = [];
  state().resetViewerState();
  useSavedSectionCuts.setState({ cuts: [], activeCutId: null });
  useViewerStore.setState({ cameraCallbacks: { getViewpoint: () => VIEW, applyViewpoint: (v) => { applied.push(v); } } });
});
afterEach(cleanup);

const menu = () => document.querySelector<HTMLElement>('[data-testid="section-views-menu"]');
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="section-view-row"]')];
const nameField = () => menu()!.querySelector<HTMLInputElement>('input[aria-label="Name for the saved view"]')!;
const button = (label: string, root: ParentNode = menu()!) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!;
const names = () => orderedSectionPlanes(state().sectionPlane, state().inactiveSectionPlanes).map((p) => `${p.name}:${p.axis}:${p.position}`);

function twoPlanes() {
  state().setActiveTool('section');
  state().addSectionPlane('down'); state().setSectionPlanePosition(40);
  state().addSectionPlane('side'); state().setSectionPlanePosition(70);
}

describe('saved views on the Section bar (#7545)', () => {
  it('the popover is a dialog with a name', () => {
    render(<SectionViewsMenu />);
    click(document.querySelector('[data-testid="section-views"]')!);
    assert.equal(menu()!.getAttribute('role'), 'dialog');
    assert.equal(menu()!.getAttribute('aria-label'), 'Views');
  });

  it('saves the current planes under a name, and applying it later brings them and the camera back', () => {
    twoPlanes();
    const before = names();
    render(<SectionViewsMenu />);
    click(document.querySelector('[data-testid="section-views"]')!);
    assert.match(menu()!.textContent ?? '', /Nothing saved yet/);
    type(nameField(), 'Wing cut');
    click(button('Save current'));
    assert.equal(rows().length, 1);
    assert.match(rows()[0]!.textContent ?? '', /Wing cut/);
    assert.match(rows()[0]!.textContent ?? '', /2 planes/);

    act(() => { state().clearSectionPlanes(); state().addSectionPlane('front'); state().setActiveTool('select'); });
    click(rows()[0]!.querySelector('button')!);
    assert.deepEqual(names(), before);
    assert.equal(state().activeTool, 'section');
    assert.deepEqual(applied, [VIEW]);
  });

  it('has nothing to save before there is a plane: Save is off, and the store refuses', () => {
    render(<SectionViewsMenu />);
    click(document.querySelector('[data-testid="section-views"]')!);
    assert.equal(button('Save current').disabled, true, 'a viewer with no plane holds only a placeholder, which would cut when applied');
    assert.throws(() => saveCurrentSectionCut('Nothing'), /no cutting plane/);
    assert.equal(rows().length, 0);
    act(() => { twoPlanes(); });
    assert.equal(button('Save current').disabled, false);
  });

  it('an unnamed save is named for you; rename and delete work in place', () => {
    twoPlanes();
    render(<SectionViewsMenu />);
    click(document.querySelector('[data-testid="section-views"]')!);
    click(button('Save current'));
    assert.match(rows()[0]!.textContent ?? '', /View 1/);
    click(button('Rename', rows()[0]!));
    const field = menu()!.querySelector<HTMLInputElement>('input[aria-label="New name for the saved view"]')!;
    type(field, 'Floor plan');
    press(field, 'Enter');
    assert.match(rows()[0]!.textContent ?? '', /Floor plan/);
    click(button('Delete', rows()[0]!));
    assert.equal(rows().length, 0);
  });
});
