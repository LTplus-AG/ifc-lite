/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section tool on the HUD (#5499, charter #5478 §6): its bar is the
 * `section` row's `Bar` in `TOOL_HUD`, so it lands in the HUD's top-center
 * region through `ToolOverlays` (placement by region, never by coordinates),
 * and every control drives the store — asserted on the OUTPUT (store state,
 * rendered text, `aria-checked` / `aria-pressed`), never on the wiring.
 *
 * The distance field shows METRES resolved against the merged model bounds
 * (a [0, 10] x [-1, 3] x [0, 8] box here), so the store's percentage and the
 * bar's metres are two views of one cut.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, press, type, blur } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';

const s = () => useViewerStore.getState();

/** One model over a [0,10] x [-1,3] x [0,8] box with two storeys at 0 m and 2.8 m. */
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
      spatialHierarchy: {
        byStorey: new Map([[10, []], [11, []]]),
        storeyElevations: new Map([[10, 0], [11, 2.8]]),
      },
      entities: { ...base.ifcDataStore!.entities, getName: (id: number) => (id === 10 ? 'Ground floor' : id === 11 ? 'First floor' : null) },
    },
  } as unknown as FederatedModel;
}

function reset(models: FederatedModel[]): void {
  window.localStorage.clear();
  // A persisted cardinal mode, so the tool opens on a known cut rather than
  // arming the face pick (its own tests below).
  window.localStorage.setItem('ifc-lite:section-last-mode', JSON.stringify({ kind: 'cardinal', axis: 'down', position: 50, flipped: false }));
  useViewerStore.setState({
    activeTool: 'section',
    sectionPlane: getDefaultSectionPlane(),
    sectionPickMode: false,
    sectionPickPreview: null,
    models: new Map(models.map((m) => [m.id, m])),
    activeModelId: models[0]?.id ?? null,
    geometryResult: null,
    ifcDataStore: null,
    pointCloudAssetCount: 0,
    pointCloudPreviewStride: 1,
    drawing2DPanelVisible: false,
    drawing2D: null,
    floatingPanels: [],
    poppedOutIds: [],
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
}

beforeEach(() => reset([boundedModel()]));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const renderTool = () => render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);

function region(name: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-hud-region="${name}"]`);
  assert.ok(node, `no HUD region ${name}`);
  return node;
}
function bar(): HTMLElement {
  const el = region('top-center').querySelector<HTMLElement>('[data-tool-bar="section"]');
  assert.ok(el, 'the Section bar is a top-center HUD item');
  return el;
}
function radio(label: string): HTMLButtonElement {
  const el = [...bar().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent?.trim() === label);
  assert.ok(el, `no "${label}" segment on the bar`);
  return el;
}
function toggle(label: string): HTMLButtonElement {
  const el = [...bar().querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  assert.ok(el, `no "${label}" toggle on the bar`);
  return el;
}
function field(): HTMLElement {
  const el = bar().querySelector<HTMLElement>('[role="spinbutton"]');
  assert.ok(el, 'no distance field on the bar');
  return el;
}
function pointer(el: Element, kind: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number): void {
  act(() => {
    el.dispatchEvent(new window.PointerEvent(kind, { bubbles: true, cancelable: true, clientX, pointerId: 1, button: 0 }));
  });
}

describe('Section bar placement on the HUD (#5499)', () => {
  it('is the top-center HUD item and nothing of the tool is an absolute card any more', () => {
    const ui = renderTool();
    assert.equal(region('top-center').querySelectorAll(':scope > [data-hud-item]').length, 1);
    assert.ok(bar().closest('[data-hud-item]'));
    assert.equal(bar().getAttribute('data-tour'), 'section-panel', 'the tour anchor moved onto the bar');
    // The cap form is behind a popover, not an expanding card.
    assert.equal(ui.querySelector('[data-section-cap-controls]'), null);
    assert.equal(region('top-left').textContent, '');
  });
});

describe('Section bar controls drive the store', () => {
  it('the axis segments write the cardinal axis and show the current one checked', () => {
    renderTool();
    assert.equal(radio('Down').getAttribute('aria-checked'), 'true');
    click(radio('Front'));
    assert.equal(s().sectionPlane.axis, 'front');
    assert.equal(s().sectionPlane.custom, undefined);
    assert.equal(radio('Front').getAttribute('aria-checked'), 'true');
    assert.equal(radio('Down').getAttribute('aria-checked'), 'false');
  });

  it('Face arms the pick and reads as the checked segment; a cardinal segment disarms it', () => {
    renderTool();
    click(radio('Face'));
    assert.equal(s().sectionPickMode, true);
    assert.equal(radio('Face').getAttribute('aria-checked'), 'true');
    assert.match(radio('Face').title, /Click any face/);
    click(radio('Side'));
    assert.equal(s().sectionPickMode, false);
    assert.equal(s().sectionPlane.axis, 'side');
    assert.equal(radio('Side').getAttribute('aria-checked'), 'true');
  });

  it('a face-picked plane keeps Face checked and the field edits its signed distance', () => {
    renderTool();
    act(() => s().setSectionPlaneFromFace([1, 0, 0], [-2.345, 0, 0]));
    assert.equal(radio('Face').getAttribute('aria-checked'), 'true');
    // The pick insets the plane off the face (#5480), so read the committed distance back.
    const picked = s().sectionPlane.custom!.distance;
    assert.equal(field().getAttribute('aria-valuetext'), `${picked.toFixed(2)}m`);
    press(field(), 'ArrowUp');
    assert.ok(Math.abs(s().sectionPlane.custom!.distance - (picked + 0.05)) < 1e-9, 'one step is 0.05 m along the normal');
    click(radio('Down'));
    assert.equal(s().sectionPlane.custom, undefined, 'a cardinal segment drops the custom plane');
  });

  it('Flip is a pressed toggle bound to the store', () => {
    renderTool();
    assert.equal(toggle('Flip cut direction').getAttribute('aria-pressed'), 'false');
    click(toggle('Flip cut direction'));
    assert.equal(s().sectionPlane.flipped, true);
    assert.equal(toggle('Unflip cut direction').getAttribute('aria-pressed'), 'true');
  });

  it('the distance field shows metres against the model bounds and writes back a percentage', () => {
    renderTool();
    // position 50 % of Y in [-1, 3] is 1 m.
    assert.equal(field().getAttribute('aria-valuetext'), '1.00m');
    press(field(), 'ArrowUp');
    assert.ok(Math.abs(s().sectionPlane.position - 52.5) < 1e-9, '0.1 m over a 4 m range is 2.5 %');
    assert.equal(field().getAttribute('aria-valuetext'), '1.10m');
    press(field(), 'ArrowDown', { shiftKey: true });
    assert.ok(Math.abs(s().sectionPlane.position - 27.5) < 1e-9, 'Shift steps 1 m');
    // Click, type 2.6 m, Enter: (2.6 + 1) / 4 = 90 %.
    press(field(), 'Enter');
    const input = bar().querySelector<HTMLInputElement>('input[aria-label="Cut distance along the axis"]');
    assert.ok(input, 'Enter opens the type-to-set input');
    type(input, '2.6');
    press(input, 'Enter');
    assert.ok(Math.abs(s().sectionPlane.position - 90) < 1e-9);
    assert.equal(field().getAttribute('aria-valuetext'), '2.60m');
  });

  it('a scrub snaps onto a storey cut (floor + 1.2 m) and thins a loaded scan only while dragging', () => {
    useViewerStore.setState({ pointCloudAssetCount: 1 });
    renderTool();
    const el = field();
    Object.defineProperty(el, 'setPointerCapture', { configurable: true, value: () => {} });
    Object.defineProperty(el, 'hasPointerCapture', { configurable: true, value: () => false });
    pointer(el, 'pointerdown', 100);
    // 1.00 m + 12 steps of 0.1 m = 2.2 m; within 0.15 m of the first-floor
    // cut at 2.8 + 1.2 = 4.0? No — of nothing; it stays 2.20 m.
    pointer(el, 'pointermove', 172);
    assert.equal(s().pointCloudPreviewStride, 4, 'a scan is thinned while scrubbing');
    assert.equal(field().getAttribute('aria-valuetext'), '2.20m');
    // 1.00 m + 1 step = 1.1 m is within 0.15 m of the ground-floor cut at 1.2 m: snaps.
    pointer(el, 'pointermove', 106);
    assert.equal(field().getAttribute('aria-valuetext'), '1.20m');
    assert.ok(Math.abs(s().sectionPlane.position - 55) < 1e-9);
    pointer(el, 'pointerup', 106);
    assert.equal(s().pointCloudPreviewStride, 1, 'restored on release');
  });

  it('the storey menu lists storeys top-down and cuts at the chosen storey', () => {
    renderTool();
    click(bar().querySelector('button[aria-label="Cut at a storey"]')!);
    const menu = document.querySelector<HTMLElement>('[data-testid="section-storeys"]');
    assert.ok(menu, 'the storey popover opened');
    const rows = [...menu.querySelectorAll('li')];
    assert.deepEqual(rows.map((r) => r.querySelector('button')?.textContent?.trim()), ['First floor2.80 m', 'Ground floor0.00 m']);
    // 1.00 m is within 0.15 m of the ground-floor cut (0 + 1.2)? No: 0.2 m away, so nothing is current yet.
    assert.equal(menu.querySelector('button[aria-current="true"]'), null);
    assert.equal(menu.querySelector('button[aria-current="true"]'), null, '1.00 m is 0.2 m off the ground-floor cut: nothing current');
    click(rows[0].querySelector('button')!);
    // 2.8 + 1.2 = 4 m is the top of the Y range: 100 %.
    assert.equal(s().sectionPlane.position, 100);
    assert.equal(s().sectionPlane.axis, 'down');
  });

  it('the storey menu is absent for a vertical cut and without storeys', () => {
    renderTool();
    click(radio('Front'));
    assert.equal(bar().querySelector('button[aria-label="Cut at a storey"]'), null);
  });

  it('falls back to a percentage while no model bounds exist', () => {
    reset([]);
    renderTool();
    assert.equal(field().getAttribute('aria-valuetext'), '50.00%');
    press(field(), 'ArrowUp');
    assert.equal(s().sectionPlane.position, 51);
  });

  it('Cap opens the one popover and its toggles write the cap flags', () => {
    renderTool();
    click([...bar().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Cap')!);
    const cap = document.querySelector<HTMLElement>('[data-section-cap-controls]');
    assert.ok(cap, 'the Cap popover opened');
    const surfaces = [...cap.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) => b.textContent?.trim() === 'Surfaces')!;
    assert.equal(surfaces.getAttribute('aria-pressed'), 'true');
    click(surfaces);
    assert.equal(s().sectionPlane.showCap, false);
    assert.equal(cap.querySelector('fieldset')?.hasAttribute('disabled'), true, 'hatch inputs disable with surfaces off');
  });

  it('Cut toggles clipping in place of the old CLIP chip', () => {
    renderTool();
    assert.equal(toggle('Cut').getAttribute('aria-pressed'), 'true');
    click(toggle('Cut'));
    assert.equal(s().sectionPlane.enabled, false);
    assert.equal(toggle('Cut').getAttribute('aria-pressed'), 'false');
    assert.equal(document.querySelector('[data-section-clip-toggle]'), null);
  });

  it('2D opens the Drawing panel docked with a fresh drawing, and closes it when pressed again', () => {
    useViewerStore.setState({ drawing2D: { marker: 'stale' } as never });
    renderTool();
    assert.equal(toggle('2D').getAttribute('aria-pressed'), 'false');
    click(toggle('2D'));
    assert.equal(s().drawing2DPanelVisible, true);
    assert.equal(s().drawing2D, null);
    assert.equal(toggle('2D').getAttribute('aria-pressed'), 'true');
    click(toggle('2D'));
    assert.equal(s().drawing2DPanelVisible, false);
  });

  it('Close returns to the select tool and restores the scan stride', () => {
    useViewerStore.setState({ pointCloudPreviewStride: 4 });
    renderTool();
    click(bar().querySelector('button[title="Close"]')!);
    assert.equal(s().activeTool, 'select');
    assert.equal(s().pointCloudPreviewStride, 1);
    assert.equal(region('top-center').querySelectorAll('[data-hud-item]').length, 0);
  });

  it('a blurred type-to-set commits like Enter does', () => {
    renderTool();
    press(field(), 'Enter');
    const input = bar().querySelector<HTMLInputElement>('input[role="textbox"], input[inputmode="decimal"]')!;
    type(input, '-1');
    blur(input);
    assert.equal(s().sectionPlane.position, 0);
  });
});
