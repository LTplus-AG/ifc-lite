/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The offset and plane controls of the active plane (#7545), driven like a user:
 * a typed value in the project's own unit, the wheel, the `− +` steppers, the
 * step menu, Flip / Set view / Show, and the one-click Fill. Assertions are on the
 * store, the shown value and the camera calls, not on wiring.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, press, type } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { fixtureModel } from '@/test/store-fixture.js';
import type { CameraCallbacks, CameraViewpoint } from '@/store/types';
import { useSectionStep } from './sectionStep.js';
import { resetRememberedHatch } from './useSectionFill.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';

const s = () => useViewerStore.getState();

/** A model over a [0,10] x [-1,3] x [0,8] metre box whose project unit is `scale` metres per unit. */
function model(lengthUnitScale: number): FederatedModel {
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
    ifcDataStore: { ...base.ifcDataStore, lengthUnitScale, source: new Uint8Array(0) },
  } as unknown as FederatedModel;
}

const camera = {
  applied: [] as Array<{ viewpoint: CameraViewpoint }>,
  presets: [] as string[],
  current: { position: { x: 20, y: 20, z: 20 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, fov: 0.8, projectionMode: 'perspective' } as CameraViewpoint,
};

function setup(unitScale = 1): void {
  window.localStorage.clear();
  useSectionStep.setState({ stepM: 0.1 });
  resetRememberedHatch();
  camera.applied = []; camera.presets = [];
  const m = model(unitScale);
  useViewerStore.setState({
    activeTool: 'section', sectionPlane: getDefaultSectionPlane(), inactiveSectionPlanes: [], sectionUndo: null,
    sceneState: { section: { visible: true }, measurements: { visible: true } },
    sectionPickMode: false, sectionPickPreview: null, sectionPickTarget: 'replace',
    models: new Map([[m.id, m]]), activeModelId: m.id, geometryResult: null, ifcDataStore: null,
    pointCloudAssetCount: 0, drawing2DPanelVisible: false, drawing2D: null, floatingPanels: [], poppedOutIds: [],
    cameraCallbacks: {
      getViewpoint: () => camera.current,
      applyViewpoint: (viewpoint: CameraViewpoint) => { camera.applied.push({ viewpoint }); },
      setPresetView: (view: Parameters<NonNullable<CameraCallbacks['setPresetView']>>[0]) => { camera.presets.push(view); },
    } satisfies CameraCallbacks,
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
  s().addSectionPlane('down');
}

beforeEach(() => setup());
afterEach(cleanup);

const renderTool = () => render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
const bar = () => document.querySelector<HTMLElement>('[data-hud-region="top-center"] [data-tool-bar="section"]')!;
const field = () => bar().querySelector<HTMLElement>('[role="spinbutton"]')!;
const shown = () => field().getAttribute('aria-valuetext');
const button = (label: string) => {
  const el = [...bar().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label || b.title === label);
  assert.ok(el, `no "${label}" button`);
  return el;
};
function wheel(el: Element, deltaY: number, init: { shiftKey?: boolean } = {}): void {
  const event = new window.Event('wheel', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'deltaY', { value: deltaY });
  Object.defineProperty(event, 'shiftKey', { value: !!init.shiftKey });
  Object.defineProperty(event, 'altKey', { value: false });
  act(() => { el.dispatchEvent(event); });
}
const worldY = () => -1 + (s().sectionPlane.position / 100) * 4;

describe('the offset speaks the project unit, to the millimetre (#7545)', () => {
  it('metres: three decimals, typed value lands in metres', () => {
    renderTool();
    assert.equal(shown(), '1.000m');
    press(field(), 'Enter');
    const input = bar().querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    type(input, '-0.2');
    press(input, 'Enter');
    assert.ok(Math.abs(worldY() - -0.2) < 1e-9);
    assert.equal(shown(), '-0.200m');
  });

  it('millimetres: the field shows and accepts millimetres while the store keeps metres', () => {
    cleanup();
    setup(0.001);
    renderTool();
    assert.equal(shown(), '1000.0mm', 'a metre of height is 1000 mm in a millimetre project');
    press(field(), 'Enter');
    const input = bar().querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    type(input, '-200');
    press(input, 'Enter');
    assert.ok(Math.abs(worldY() - -0.2) < 1e-9, 'typed -200 mm is -0.2 m in the store');
    assert.equal(shown(), '-200.0mm');
  });
});

describe('stepping the offset (#7545)', () => {
  it('the wheel moves one step per notch, up is forward, and the step is the preference', () => {
    renderTool();
    wheel(field(), -120);
    wheel(field(), -120);
    assert.equal(shown(), '1.200m');
    wheel(field(), 120);
    assert.equal(shown(), '1.100m');
    act(() => useSectionStep.getState().setStepM(0.007));
    wheel(field(), -120);
    assert.equal(shown(), '1.107m', 'a custom 7 mm step');
  });

  it('the − and + buttons step the same way, and the arrow keys agree', () => {
    renderTool();
    click(button('Move the plane forward by one step'));
    assert.equal(shown(), '1.100m');
    click(button('Move the plane back by one step'));
    click(button('Move the plane back by one step'));
    assert.equal(shown(), '0.900m');
    press(field(), 'ArrowUp');
    assert.equal(shown(), '1.000m');
  });

  it('the step menu sets the step, remembers it, and a custom millimetre value works', () => {
    renderTool();
    assert.match(button('Offset step').textContent ?? '', /10 cm/);
    click(button('Offset step'));
    const menu = document.querySelector<HTMLElement>('[data-testid="section-step-menu"]')!;
    assert.ok(menu, 'the step menu opened');
    click([...menu.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === '5 cm')!);
    assert.equal(useSectionStep.getState().stepM, 0.05);
    assert.equal(window.localStorage.getItem('ifc-lite:section-step'), '0.05');
    wheel(field(), -1);
    assert.equal(shown(), '1.050m');
    const custom = menu.querySelector<HTMLInputElement>('input')!;
    type(custom, '3');
    press(custom, 'Enter');
    assert.ok(Math.abs(useSectionStep.getState().stepM - 0.003) < 1e-12);
    act(() => useSectionStep.getState().setStepM(5000));
    assert.ok(Math.abs(useSectionStep.getState().stepM - 0.003) < 1e-12, 'an unusable step is ignored');
  });
});

describe('where zero is (#7545)', () => {
  it('a level plane reads its elevation, a face plane reads from its face, and the field says which', () => {
    renderTool();
    assert.equal(bar().querySelector('[data-testid="section-offset-datum"]')?.textContent, 'level');
    act(() => s().setSectionPlaneAxis('side'));
    assert.equal(bar().querySelector('[data-testid="section-offset-datum"]')?.textContent, 'at X', 'a side plane is a coordinate, not an elevation');
    act(() => s().setSectionPlaneAxis('front'));
    assert.equal(bar().querySelector('[data-testid="section-offset-datum"]')?.textContent, 'at Y');
    act(() => s().setSectionPlaneAxis('down'));
    act(() => s().setSectionPlaneFromFace([1, 0, 0], [4, 1, 1]));
    assert.equal(bar().querySelector('[data-testid="section-offset-datum"]')?.textContent, 'from face');
    assert.equal(shown(), '0.000m', 'a fresh pick starts at zero');
    wheel(field(), 1);
    assert.equal(shown(), '-0.100m', 'negative is into the solid');
    const c = s().sectionPlane.custom!;
    assert.ok(Math.abs(c.distance - (c.datum! - 0.1)) < 1e-9);
  });
});

describe('Flip, Set view and Show (#7545)', () => {
  it('Flip is a labelled toggle for the active plane only', () => {
    renderTool();
    s().addSectionPlane('side');
    click(button('Flip cut direction'));
    assert.equal(s().sectionPlane.flipped, true);
    assert.equal(s().inactiveSectionPlanes[0]!.flipped, false);
    assert.equal(button('Unflip cut direction').textContent?.trim(), 'Flip');
  });

  it('Set view for a level plane picks the matching preset, and again returns to the camera the user had', () => {
    renderTool();
    click(button('Set view'));
    assert.deepEqual(camera.presets, ['top']);
    // Pressing it again goes back to the remembered viewpoint.
    click(button('Go back to the previous view'));
    assert.deepEqual(camera.applied.map((a) => a.viewpoint), [camera.current]);
  });

  it('Set view for a flipped level plane looks from below', () => {
    renderTool();
    click(button('Flip cut direction'));
    click(button('Set view'));
    assert.deepEqual(camera.presets, ['bottom']);
  });

  it('Set view for a face plane looks straight along it from the removed side', () => {
    renderTool();
    act(() => s().setSectionPlaneFromFace([1, 0, 0], [4, 1, 1]));
    click(button('Set view'));
    const v = camera.applied[0]!.viewpoint;
    assert.ok(v.position.x > v.target.x, 'the eye is on the +normal side of an unflipped plane');
    assert.ok(Math.abs(v.position.y - v.target.y) < 1e-6 && Math.abs(v.position.z - v.target.z) < 1e-6, 'straight along the normal');
  });

  it('Set view starts over when another plane becomes active', () => {
    renderTool();
    click(button('Set view'));
    act(() => { s().addSectionPlane('side'); });
    assert.equal(button('Set view').getAttribute('aria-pressed'), 'false');
  });

  it('Show hides a plane\'s outline and tag without touching the cut', () => {
    renderTool();
    assert.equal(button('Show').getAttribute('aria-pressed'), 'true');
    click(button('Show'));
    assert.equal(s().sectionPlane.showGizmo, false);
    assert.equal(s().sectionPlane.enabled, true);
    assert.equal(button('Show').getAttribute('aria-pressed'), 'false');
  });
});

describe('Fill slice (#7545)', () => {
  it('one click paints the cut solid; a second returns to the hatch the user had', () => {
    renderTool();
    act(() => s().setSectionCapStyle({ pattern: 'brick' }));
    assert.equal(button('Fill').getAttribute('aria-pressed'), 'false');
    click(button('Fill'));
    assert.equal(s().sectionPlane.capStyle.pattern, 'solid');
    assert.equal(s().sectionPlane.showCap, true);
    assert.equal(button('Fill').getAttribute('aria-pressed'), 'true');
    click(button('Fill'));
    assert.equal(s().sectionPlane.capStyle.pattern, 'brick');
  });

  it('turns surfaces back on when they were off, and reaches every plane', () => {
    renderTool();
    s().addSectionPlane('side');
    act(() => s().setSectionShowCap(false));
    click(button('Fill'));
    for (const p of [s().sectionPlane, ...s().inactiveSectionPlanes]) {
      assert.equal(p.showCap, true);
      assert.equal(p.capStyle.pattern, 'solid');
    }
  });
});
