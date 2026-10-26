/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section bar's storey menu above the model top (#8162). A model whose
 * Y range is [0, 3] m with a top storey at 2.5 m: the plan cut is 3.7 m, above
 * the top. The store keeps it there (> 100 %), the distance field shows 3.7 m,
 * and a step, an arrow key or a drag commits back within the bounds. A storey
 * whose floor lies outside the range keeps the clamped fallback.
 */

import '@/test/setup-dom.js';
import '@/test/section-tool-ready.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, press } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { useSectionStep } from './sectionStep.js';
import { useSectionDistance } from './useSectionDistance.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';

const s = () => useViewerStore.getState();
const RANGE = { min: 0, max: 3 };
const worldY = () => RANGE.min + (s().sectionPlane.position / 100) * (RANGE.max - RANGE.min);

/** [0,10] x [0,3] x [0,8] m; storeys at 0 m, 2.5 m (top) and 10 m (a floor outside the range). */
function model(): FederatedModel {
  const base = fixtureModel('m');
  const box = { min: { x: 0, y: RANGE.min, z: 0 }, max: { x: 10, y: RANGE.max, z: 8 } };
  const names = new Map([[10, 'Ground'], [11, 'Top'], [12, 'Stray']]);
  return {
    ...base,
    geometryResult: {
      meshes: [], totalVertices: 0, totalTriangles: 0,
      coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: box, shiftedBounds: box, hasLargeCoordinates: false },
    },
    ifcDataStore: {
      ...base.ifcDataStore,
      spatialHierarchy: {
        byStorey: new Map([[10, []], [11, []], [12, []]]),
        storeyElevations: new Map([[10, 0], [11, 2.5], [12, 10]]),
      },
      entities: { ...base.ifcDataStore!.entities, getName: (id: number) => names.get(id) ?? null },
    },
  } as unknown as FederatedModel;
}

beforeEach(() => {
  window.localStorage.clear();
  useSectionStep.setState({ stepM: 0.1 });
  const m = model();
  useViewerStore.setState({
    activeTool: 'section', sectionPlane: getDefaultSectionPlane(), inactiveSectionPlanes: [], sectionUndo: null,
    sceneState: { section: { visible: true }, measurements: { visible: true } },
    sectionPickMode: false, sectionPickPreview: null,
    models: new Map([[m.id, m]]), activeModelId: m.id, geometryResult: null, ifcDataStore: null,
    pointCloudAssetCount: 0, pointCloudPreviewStride: 1, drawing2DPanelVisible: false, drawing2D: null, floatingPanels: [], poppedOutIds: [],
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
  s().addSectionPlane('down');
});
afterEach(() => { cleanup(); window.localStorage.clear(); });

const renderTool = () => render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
const bar = () => document.querySelector<HTMLElement>('[data-hud-region="top-center"] [data-tool-bar="section"]')!;
const field = () => bar().querySelector<HTMLElement>('[role="spinbutton"]')!;
const shown = () => field().getAttribute('aria-valuetext');

function cutAt(name: string): void {
  // The popover stays open after a pick; only open it when it is closed.
  if (!document.querySelector('[data-testid="section-storeys"]')) click(bar().querySelector('button[aria-label="Cut at a storey"]')!);
  const menu = document.querySelector<HTMLElement>('[data-testid="section-storeys"]');
  assert.ok(menu, 'the storey popover opened');
  const row = [...menu.querySelectorAll('button')].find((b) => b.textContent?.startsWith(name));
  assert.ok(row, `no storey row "${name}"`);
  click(row);
}

function pointer(el: Element, kind: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number): void {
  act(() => {
    el.dispatchEvent(new window.PointerEvent(kind, { bubbles: true, cancelable: true, clientX, pointerId: 1, button: 0 }));
  });
}

describe('storey cut above the model top (#8162)', () => {
  it('cuts at floor + 1.2 m = 3.7 m (> 100 %) and the distance field shows 3.7 m', () => {
    renderTool();
    cutAt('Top');
    assert.ok(s().sectionPlane.position > 100, `position ${s().sectionPlane.position} must exceed 100`);
    assert.ok(Math.abs(worldY() - 3.7) < 1e-9, `the cut resolves to ${worldY()} m, not 3.7 m`);
    assert.equal(shown(), '3.700m');
  });

  it('an in-range storey cut is unchanged', () => {
    renderTool();
    cutAt('Ground');
    assert.ok(Math.abs(s().sectionPlane.position - 40) < 1e-9);
    assert.equal(shown(), '1.200m');
  });

  it('a storey whose floor is outside the range keeps the clamped fallback', () => {
    renderTool();
    cutAt('Stray');
    assert.equal(s().sectionPlane.position, 100);
    assert.equal(shown(), '3.000m');
  });

  it('the + / - steppers return the cut to the bounded range', () => {
    renderTool();
    cutAt('Top');
    click(stepper(1));
    assert.equal(s().sectionPlane.position, 100, '+ from 3.7 m clamps to the 3 m top');
    cutAt('Top');
    click(stepper(-1));
    assert.equal(s().sectionPlane.position, 100, '- from 3.7 m lands within the range, at the top');
  });

  it('arrow keys return the cut to the bounded range', () => {
    renderTool();
    cutAt('Top');
    press(field(), 'ArrowDown');
    assert.equal(s().sectionPlane.position, 100);
    assert.equal(shown(), '3.000m');
    cutAt('Top');
    press(field(), 'ArrowUp');
    assert.equal(s().sectionPlane.position, 100);
  });

  it('a drag returns the cut to the bounded range', () => {
    renderTool();
    cutAt('Top');
    const el = field();
    Object.defineProperty(el, 'setPointerCapture', { configurable: true, value: () => {} });
    Object.defineProperty(el, 'hasPointerCapture', { configurable: true, value: () => false });
    pointer(el, 'pointerdown', 100);
    pointer(el, 'pointermove', 112);
    pointer(el, 'pointerup', 112);
    assert.ok(s().sectionPlane.position >= 0 && s().sectionPlane.position <= 100, `dragged to ${s().sectionPlane.position}`);
  });
});

function stepper(direction: 1 | -1): HTMLButtonElement {
  const label = direction === 1 ? 'Move the plane forward by one step' : 'Move the plane back by one step';
  const el = bar().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(el, `no "${label}" stepper`);
  return el;
}

describe('the percent control keeps its bounded input (#8162)', () => {
  let distance: ReturnType<typeof useSectionDistance> | null = null;
  function Probe(): null {
    distance = useSectionDistance();
    return null;
  }

  it('with no usable bounds the field is a 0..100 percentage and commits within it', () => {
    act(() => useViewerStore.setState({ models: new Map(), geometryResult: null }));
    render(<Probe />);
    assert.equal(distance?.kind, 'percent');
    act(() => distance!.onChange(150));
    assert.equal(s().sectionPlane.position, 100);
    act(() => distance!.onChange(-5));
    assert.equal(s().sectionPlane.position, 0);
    act(() => distance!.onChange(Infinity));
    assert.equal(s().sectionPlane.position, 100);
  });
});
