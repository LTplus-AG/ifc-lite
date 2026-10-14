/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Zoom popover on the Section bar (#7545), driven like a user: pick what to
 * frame and the margin, press Zoom, and the camera is asked for exactly that.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { render, cleanup, click, press, type } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { DEFAULT_SECTION_ZOOM } from '@/lib/section/section-zoom-spec';
import { SectionZoomMenu } from './SectionZoomMenu.js';

const state = () => useViewerStore.getState();
const SCENE = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 6, z: 4 } };
let frames: Array<{ padding?: number; max: { x: number; y: number; z: number } }> = [];

beforeEach(() => {
  frames = [];
  state().resetViewerState();
  useViewerStore.setState({
    sectionZoom: DEFAULT_SECTION_ZOOM,
    selectedEntityId: null,
    selectedEntityIds: new Set<number>(),
    cameraCallbacks: {
      selectionBounds: () => ({ min: { x: 2, y: 1, z: 0 }, max: { x: 4, y: 2, z: 1 } }),
      frameBounds: async (_min, max, options) => { frames.push({ max, ...options }); return true; },
    },
  });
  setGlobalRendererRef({ current: { getCamera: () => ({ getSceneBounds: () => SCENE }) } as unknown as Renderer });
});
afterEach(() => { cleanup(); clearGlobalRefs(); });

const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid="section-zoom"]')!;
const menu = () => document.querySelector<HTMLElement>('[data-testid="section-zoom-menu"]');
const apply = () => [...menu()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Zoom')!;
const radio = (name: RegExp) => [...menu()!.querySelectorAll<HTMLLabelElement>('label')].find((l) => name.test(l.textContent ?? ''))!.querySelector<HTMLInputElement>('input[type="radio"]')!;
const marginField = () => menu()!.querySelector<HTMLInputElement>('input[type="text"]')!;
const unit = (symbol: string) => [...menu()!.querySelectorAll<HTMLButtonElement>('fieldset button')].find((b) => b.textContent === symbol)!;
const open = async () => { render(<SectionZoomMenu />); click(trigger()); };
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the Zoom popover (#7545)', () => {
  it('needs a selection to zoom to one, and says so; selecting something enables it', async () => {
    await open();
    assert.equal(apply().disabled, true);
    assert.match(menu()!.textContent ?? '', /Select something to zoom to it/);
    act(() => useViewerStore.setState({ selectedEntityId: 7 }));
    assert.equal(apply().disabled, false);
  });

  it('frames the chosen target with the typed margin, and remembers the choice', async () => {
    await open();
    click(radio(/Whole model/));
    type(marginField(), '25');
    click(apply());
    await settle();
    assert.equal(frames.length, 1);
    assert.ok(Math.abs(frames[0]!.padding! - 1.5) < 1e-12, '25 % each side of the model');
    assert.deepEqual(state().sectionZoom, { target: 'model', margin: { kind: 'fraction', value: 0.25 } });
    assert.equal(menu(), null, 'the menu closes once something was framed');
  });

  it('a length margin is metres on each side; Enter applies', async () => {
    await open();
    click(radio(/Whole model/));
    click(unit('m'));
    type(marginField(), '1');
    press(marginField(), 'Enter');
    await settle();
    assert.ok(Math.abs(frames[0]!.padding! - 1.2) < 1e-12, '1 m each side of a 10 m extent');
    assert.deepEqual(state().sectionZoom.margin, { kind: 'metres', value: 1 });
  });

  it('refuses a margin that is not a number, and a cut that leaves nothing says so', async () => {
    await open();
    click(radio(/Whole model/));
    type(marginField(), 'abc');
    assert.equal(apply().disabled, true);
    assert.equal(marginField().getAttribute('aria-invalid'), 'true');
    type(marginField(), '10');
    // The planes cut the whole model away: nothing to frame, and the menu stays open with the reason.
    state().setActiveTool('section');
    state().addSectionPlane('side'); state().setSectionPlanePosition(30);
    state().addSectionPlane('side'); state().setSectionPlanePosition(60); state().flipSectionPlane();
    click(radio(/Cut area/));
    click(apply());
    await settle();
    assert.deepEqual(frames, []);
    assert.match(menu()!.textContent ?? '', /Nothing to frame/);
  });

  it('opens on the last choice', async () => {
    useViewerStore.setState({ sectionZoom: { target: 'cut-region', margin: { kind: 'metres', value: 2 } } });
    await open();
    assert.equal(radio(/Cut area/).checked, true);
    assert.equal(marginField().value, '2');
    assert.equal(unit('m').getAttribute('aria-pressed'), 'true');
  });
});
