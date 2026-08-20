/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Proof that radius mode (#2737 item 2) is reachable through the SHIPPED
 * panel, not just through the store: mounts the real `MeasureOverlay`,
 * drives `handleRadiusClick` (the same function a canvas click calls) and
 * `finishRadius` (the same function Enter calls), and reads the DOM text a
 * user would actually see.
 *
 * Two cases matter, per the issue's acceptance: a genuine arc must show a
 * fitted radius WITH its provenance, and a straight run must show a visible
 * refusal — not silence, not a stale previous reading.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store/index.js';
import { MeasureOverlay } from './MeasurePanel.js';
import { handleRadiusClick } from '../selectionHandlers.js';
import type { MouseHandlerContext } from '../mouseHandlerTypes.js';
import type { Point3 } from './measure-modes/radius.js';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderNode(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TooltipProvider>{node}</TooltipProvider>);
  });
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

/** Click the panel's section button whose label is `label`. */
function openSection(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  assert.ok(button, `no section button labelled "${label}" on the measure panel`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function fakeCtx(hit: { x: number; y: number; z: number } | null): MouseHandlerContext {
  const canvas = document.createElement('canvas');
  return {
    canvas,
    camera: {
      projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y }),
      getPosition: () => ({ x: 0, y: 0, z: 0 }),
      getRotation: () => ({ azimuth: 0, elevation: 0 }),
      getDistance: () => 10,
    },
    renderer: {
      raycastSceneMagnetic: () => ({
        intersection: hit ? { point: hit } : null,
        snapTarget: null,
        edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
      }),
    },
    mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
    activeToolRef: { current: 'measure' },
    snapEnabledRef: { current: true },
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, edgeT: 0, lockStrength: 0, isCorner: false, cornerValence: 0 } },
    hiddenEntitiesRef: { current: new Set() },
    isolatedEntitiesRef: { current: null },
    setSnapTarget: () => {},
  } as unknown as MouseHandlerContext;
}

const CENTER = { x: 42.5, y: -7.3, z: 12.1 };
const RADIUS = 3.2;

function arcPoints(): Point3[] {
  const normal = { x: 2, y: 3, z: 0.6 }; // off-axis, weighted toward XY so this
  // harness's identity-ish projection doesn't collapse consecutive picks —
  // same reasoning as selectionHandlers.radius.test.ts's own fixture.
  const n = Math.hypot(normal.x, normal.y, normal.z);
  const nn = { x: normal.x / n, y: normal.y / n, z: normal.z / n };
  const seed = Math.abs(nn.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const uRaw = {
    x: seed.y * nn.z - seed.z * nn.y,
    y: seed.z * nn.x - seed.x * nn.z,
    z: seed.x * nn.y - seed.y * nn.x,
  };
  const uLen = Math.hypot(uRaw.x, uRaw.y, uRaw.z);
  const u = { x: uRaw.x / uLen, y: uRaw.y / uLen, z: uRaw.z / uLen };
  const v = {
    x: nn.y * u.z - nn.z * u.y,
    y: nn.z * u.x - nn.x * u.z,
    z: nn.x * u.y - nn.y * u.x,
  };
  const pts: Point3[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 2) * (i / 5);
    const c = Math.cos(a) * RADIUS;
    const s = Math.sin(a) * RADIUS;
    pts.push({
      x: CENTER.x + u.x * c + v.x * s,
      y: CENTER.y + u.y * c + v.y * s,
      z: CENTER.z + u.z * c + v.z * s,
    });
  }
  return pts;
}

function straightPoints(): Point3[] {
  const dir = { x: 3, y: -1, z: 2 };
  const start = { x: 15.5, y: 4.2, z: -8.9 };
  return [0, 0.6, 1.3, 2.1, 3].map((t) => ({
    x: start.x + dir.x * t,
    y: start.y + dir.y * t,
    z: start.z + dir.z * t,
  }));
}

beforeEach(() => {
  unmountAll();
  useViewerStore.setState({
    activeTool: 'measure',
    measureMode: 'radius',
    activeRadius: null,
    radiusMeasurements: [],
    measurements: [],
    activeMeasurement: null,
    pendingMeasurePoint: null,
    angleMeasurements: [],
    activeAngle: null,
    activePolyline: null,
    polylineMeasurements: [],
    unitDisplayOverrides: {},
  });
});

describe('radius mode, driven through the shipped panel (#2737 item 2)', () => {
  it('a genuine arc shows a fitted radius WITH its provenance in the panel', () => {
    const container = renderNode(<MeasureOverlay />);
    openSection(container, 'List');

    act(() => {
      for (const p of arcPoints()) {
        handleRadiusClick(fakeCtx(p), 0, 0);
      }
      useViewerStore.getState().finishRadius();
    });

    const text = container.textContent ?? '';
    assert.match(
      text,
      /R 3\.200 m \/ D 6\.400 m \(fitted from 6 tessellation points\)/,
      `panel did not show the fitted radius with provenance; saw: ${text}`,
    );
  });

  it('a straight run shows a VISIBLE refusal in the panel, not silence or a stale reading', () => {
    const container = renderNode(<MeasureOverlay />);
    openSection(container, 'List');

    act(() => {
      for (const p of straightPoints()) {
        handleRadiusClick(fakeCtx(p), 0, 0);
      }
      useViewerStore.getState().finishRadius();
    });

    const text = container.textContent ?? '';
    assert.match(text, /Not circular \(straight\)/, `panel did not show the refusal; saw: ${text}`);
    assert.doesNotMatch(text, /R \d/, 'a straight run must never render as a numeric radius in the panel');
  });

  it('the in-progress readout updates LIVE as points are added, before any finish', () => {
    const container = renderNode(<MeasureOverlay />);
    openSection(container, 'List');

    const pts = arcPoints();
    act(() => {
      handleRadiusClick(fakeCtx(pts[0]), 0, 0);
      handleRadiusClick(fakeCtx(pts[1]), 0, 0);
    });
    assert.match(
      container.textContent ?? '',
      /Pick 1 more point/,
      'below MIN_RADIUS_POINTS the live readout must say how many more picks are needed',
    );

    act(() => {
      for (const p of pts.slice(2)) handleRadiusClick(fakeCtx(p), 0, 0);
    });
    assert.match(
      container.textContent ?? '',
      /R 3\.200 m \/ D 6\.400 m \(fitted from 6 tessellation points\)/,
      'once enough picks are in, the SAME live readout must reach the fitted answer without a separate finish step',
    );
    // Not yet recorded — still an in-progress sequence.
    assert.equal(useViewerStore.getState().radiusMeasurements.length, 0);
  });
});
