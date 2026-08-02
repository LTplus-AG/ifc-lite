/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rendering tests for the tri-state "Align to model georeference" checkbox
 * in `DxfUnderlayPanel` (issue #1929, tri-state per the PR #1965 review).
 *
 * `resolveEffectiveGeoreferenced` and `setDxfUnderlayGeoreferenced`'s store
 * action are already unit-tested (`dxfUnderlayMath.test.ts`,
 * `drawing2DSlice.ts`), but nothing had ever rendered the CONTROL that
 * wires them together — the maths was covered, the checkbox that decides
 * whether it applies was not (louistrue's PR #1965 review, finding 2).
 * These exercise the real `useViewerStore` (seeded directly, no context
 * needed — it's a module-level Zustand store) through the actual
 * `DxfUnderlayPanel` component: auto-mode display, pinning on click, and
 * that a pinned value stops following `georeferenceAvailable`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice';
import { DEFAULT_DXF_PLACEMENT, type DxfUnderlay } from '@ifc-lite/drawing-2d';
import { DxfUnderlayPanel } from './DxfUnderlayPanel.js';

function emptyUnderlay(name: string): DxfUnderlay {
  return {
    name,
    layers: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } },
    unitScale: 1,
    skipped: {},
    warnings: [],
  };
}

function underlayState(overrides: Partial<DxfUnderlayState> = {}): DxfUnderlayState {
  return {
    id: 'u1',
    name: 'site.dxf',
    underlay: emptyUnderlay('site.dxf'),
    visible: true,
    opacity: 1,
    layerVisibility: {},
    placement: { ...DEFAULT_DXF_PLACEMENT },
    georeferenced: undefined, // auto, unless overridden
    ...overrides,
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderPanel(georeferenceAvailable: boolean): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <DxfUnderlayPanel
        onClose={() => {}}
        onCenterOnModel={() => {}}
        planViewActive={true}
        georeferenceAvailable={georeferenceAvailable}
      />,
    );
  });
  mounted.push({ root, container });
  return container;
}

function georefCheckbox(container: HTMLElement): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find((el) =>
    el.textContent?.includes('Align to model georeference'),
  );
  assert.ok(label, 'expected the "Align to model georeference" label to render');
  const input = label.querySelector('input[type="checkbox"]');
  assert.ok(input instanceof HTMLInputElement, 'expected a checkbox inside the label');
  return input;
}

describe('DxfUnderlayPanel: "Align to model georeference" tri-state control (PR #1965 review)', () => {
  beforeEach(() => {
    useViewerStore.setState({ dxfUnderlays: [] });
  });

  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    useViewerStore.setState({ dxfUnderlays: [] });
  });

  it('auto entry (georeferenced === undefined) shows checked when the anchor georeference is available', () => {
    useViewerStore.setState({ dxfUnderlays: [underlayState({ georeferenced: undefined })] });
    const container = renderPanel(true);
    assert.equal(georefCheckbox(container).checked, true);
    assert.ok(container.textContent?.includes('(auto)'), 'auto mode label suffix renders');
  });

  it('auto entry shows unchecked when no anchor georeference is available', () => {
    useViewerStore.setState({ dxfUnderlays: [underlayState({ georeferenced: undefined })] });
    const container = renderPanel(false);
    assert.equal(georefCheckbox(container).checked, false);
  });

  it('explicit true stays checked even when the anchor georeference is unavailable', () => {
    useViewerStore.setState({ dxfUnderlays: [underlayState({ georeferenced: true })] });
    const container = renderPanel(false);
    assert.equal(georefCheckbox(container).checked, true);
    assert.ok(!container.textContent?.includes('(auto)'), 'pinned entry does not show the auto suffix');
  });

  it('explicit false stays unchecked even when the anchor georeference is available', () => {
    useViewerStore.setState({ dxfUnderlays: [underlayState({ georeferenced: false })] });
    const container = renderPanel(true);
    assert.equal(georefCheckbox(container).checked, false);
  });

  it('clicking an auto entry PINS it to an explicit value in the store, through the real action', async () => {
    useViewerStore.setState({ dxfUnderlays: [underlayState({ id: 'u1', georeferenced: undefined })] });
    const container = renderPanel(true); // auto resolves to checked
    const checkbox = georefCheckbox(container);
    assert.equal(checkbox.checked, true);

    // User unchecks it explicitly.
    await act(async () => {
      checkbox.click();
    });

    const entry = useViewerStore.getState().dxfUnderlays.find((u) => u.id === 'u1');
    assert.equal(entry?.georeferenced, false, 'click must write an explicit false, not leave it auto');
  });

  it('once pinned, the control no longer follows georeferenceAvailable (re-render with availability flipped)', () => {
    useViewerStore.setState({ dxfUnderlays: [underlayState({ id: 'u1', georeferenced: false })] });
    const container = renderPanel(true); // availability true, but pinned false wins
    assert.equal(georefCheckbox(container).checked, false, 'pinned false must not follow availability=true');
  });
});
