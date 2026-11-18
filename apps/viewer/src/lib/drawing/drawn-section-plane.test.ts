/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drawn plane leaves with its drawing (implicit-state-machines D2): a
 * drawing replaced, removed or cleared for a regenerate never hands its cut to
 * whatever is drawn next. `DrawingPanel.drawnPlane.test.tsx` covers the panel
 * reading it while the live plane moves.
 */
import { beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { getDefaultDrawing2DState } from '@/store/slices/drawing2DSlice';
import { drawnSectionPlane } from './drawn-section-plane';

const drawing = (): Drawing2D => ({
  config: { plane: { axis: 'y', position: 5, flipped: false }, projectionDepth: 10, includeHiddenLines: true, creaseAngle: 30, scale: 100 },
  lines: [], cutPolygons: [], projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  stats: { cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0, polygonCount: 0, totalTriangles: 0, processingTimeMs: 0 },
});
const plan = { axis: 'down' as const, position: 50, flipped: false };
const drawnAxis = () => {
  const { axis, position } = drawnSectionPlane(useViewerStore.getState());
  return `${axis}@${position}`;
};

beforeEach(() => {
  const s = useViewerStore.getState();
  useViewerStore.setState({ ...getDefaultDrawing2DState(), sectionPlane: { ...s.sectionPlane, ...plan } });
  useViewerStore.getState().setDrawing2D(drawing(), plan);
  // The user moves the cut; the plan is still the drawing.
  useViewerStore.setState({ sectionPlane: { ...useViewerStore.getState().sectionPlane, axis: 'front', position: 20 } });
  assert.equal(drawnAxis(), 'down@50');
});

it('a drawing published without its plane is drawn at the live plane', () => {
  useViewerStore.getState().setDrawing2D(drawing());
  assert.equal(drawnAxis(), 'front@20');
});

it('clearing the drawing for a regenerate drops its plane', () => {
  useViewerStore.getState().clearDrawing2D();
  assert.equal(drawnAxis(), 'front@20');
});

it('removing the drawing drops its plane', () => {
  useViewerStore.getState().setDrawing2D(null, plan);
  assert.equal(drawnAxis(), 'front@20');
});
