/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Second instance of the #2654 ghost, same class as the `removeModel` one:
 * `ClashPanel`'s unmount cleanup listed the focused-clash fields by hand and
 * the list had drifted — it cleared `clashSelectedId`, `clashHighlightColors`,
 * `clashOverlapBox` and the solid, but NOT `clashContactLines`.
 *
 * That is the field that actually matters for the common case. `useClash`
 * prefers the REAL contact interface over the AABB fallback: when the contact
 * polygon can be built it sets `clashContactLines` and nulls `clashOverlapBox`
 * (useClash.ts, focusClash). And `Viewport.tsx` draws the marker from an effect
 * keyed on `[clashOverlapBox, clashContactLines, showClashRegionBox]` — it
 * reads neither `clashSelectedId` nor `clashSolidStatus`. So closing the panel
 * on a clash whose contact HAD been built left its outline drawn in world
 * space with the panel gone.
 *
 * Both paths now route through the clash slice's `clearClashFocus()`, which is
 * the single complete spelling of this teardown.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { ClashPanel } from './ClashPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  useViewerStore.getState().setSidebarSecondaryPanel(null);
  useViewerStore.getState().closeFloatingPanel('clash');
  useViewerStore.getState().setPanelPoppedOut('clash', false);
  useViewerStore.getState().setClashPanelVisible(false);
  // The whole app shares ONE Zustand store across node:test files, so anything
  // this suite seeds has to go back.
  useViewerStore.getState().clearClashFocus();
});

describe('ClashPanel unmount ends the focused-clash presentation (#2654 review)', () => {
  it('keeps pair selection and colours while a still-open panel is remounted into a split (#5828)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useViewerStore.setState({ clashPanelVisible: true });
    await act(async () => root!.render(<ClashPanel />));

    const colours = new Map<number, [number, number, number, number]>([
      [1, [1, 0.6, 0, 1]], [2, [0, 0.8, 1, 1]],
    ]);
    await act(async () => {
      useViewerStore.setState({
        selectedEntityIds: new Set([1, 2]),
        selectedEntity: { modelId: 'model', expressId: 1 },
        clashSelectedId: 'pair',
        clashHighlightColors: colours,
      });
    });

    const first = root;
    root = null;
    await act(async () => first!.unmount());
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [1, 2]);
    assert.equal(useViewerStore.getState().selectedEntity?.expressId, 1);
    assert.equal(useViewerStore.getState().clashHighlightColors, colours);

    root = createRoot(container);
    await act(async () => root!.render(<ClashPanel />));
    await act(async () => useViewerStore.getState().setClashPanelVisible(false));
    const closing = root;
    root = null;
    await act(async () => closing!.unmount());
    assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);
    assert.equal(useViewerStore.getState().clashHighlightColors, null);
  });

  it('keeps a secondary Clash pair through float reparenting, then clears it on close (#5828)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useViewerStore.setState({ sidebarActivePanel: 'properties', clashPanelVisible: false });
    useViewerStore.getState().setSidebarSecondaryPanel('clash');
    await act(async () => root!.render(<ClashPanel />));

    const colours = new Map<number, [number, number, number, number]>([
      [3, [1, 0.6, 0, 1]], [4, [0, 0.8, 1, 1]],
    ]);
    await act(async () => {
      useViewerStore.setState({ selectedEntityIds: new Set([3, 4]), clashHighlightColors: colours });
      useViewerStore.getState().floatPanel('clash');
    });
    const docked = root;
    root = null;
    await act(async () => docked!.unmount());
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [3, 4]);
    assert.equal(useViewerStore.getState().clashHighlightColors, colours);

    root = createRoot(container);
    await act(async () => root!.render(<ClashPanel />));
    await act(async () => {
      useViewerStore.getState().setSidebarSecondaryPanel(null);
      useViewerStore.getState().closeFloatingPanel('clash');
    });
    const floating = root;
    root = null;
    await act(async () => floating!.unmount());
    assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);
    assert.equal(useViewerStore.getState().clashHighlightColors, null);
  });

  it('retracts the contact-line overlay, not just the solid and the tint', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<ClashPanel />);
    });

    // Seed the presentation `focusClash` leaves for a pair whose real contact
    // interface WAS computed: lines set, box null (the preferred marker).
    await act(async () => {
      useViewerStore.setState({
        clashSelectedId: 'rule-1 m:1 m:2',
        clashHighlightColors: new Map<number, [number, number, number, number]>([[1, [1, 0.6, 0, 1]]]),
        clashOverlapBox: null,
        clashContactLines: { vertices: [0, 0, 0, 1, 0, 0] },
        clashSolidStatus: 'solid',
        clashSolidMesh: { positions: new Float64Array([0, 0, 0]), indices: new Uint32Array([0]) },
        clashSolidVolumeM3: 0.42,
      });
    });

    const closing = root;
    root = null;
    await act(async () => closing!.unmount());

    const s = useViewerStore.getState();
    assert.equal(
      s.clashContactLines,
      null,
      'closing the panel must retract the contact outline — Viewport draws it off this field alone',
    );
    assert.equal(s.clashOverlapBox, null, 'and the AABB fallback marker');
    assert.equal(s.clashHighlightColors, null, 'and the A/B pair tint');
    assert.equal(s.clashSelectedId, null, 'and the focused clash itself');
    assert.equal(s.clashSolidStatus, 'none', 'and the intersection solid');
    assert.equal(s.clashSolidMesh, null, 'including its mesh');
  });
});
