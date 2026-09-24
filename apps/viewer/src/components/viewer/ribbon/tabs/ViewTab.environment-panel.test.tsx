/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5506: the ribbon's View → Lighting button used to toggle the floating
 * `SunSkyPanel` via `envPanelOpen`/`toggleEnvPanel`. It now opens the docked
 * Environment side panel through the shared `toggleWorkspacePanel` flow
 * (`useWorkspacePanelControls`/`store/index.ts`, the same one Location
 * zones / Load report / Cost use) — asserted on the OUTPUT the sidebar
 * reads (`sidebarActivePanel`), not on which function got called, so a
 * regression that reroutes the click to a no-op still fails this test.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { ViewTab } from './ViewTab.js';

function lightingButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((b) => /Lighting/.test(b.textContent ?? ''));
  assert.ok(button, 'expected a ribbon button labelled "Lighting"');
  return button as HTMLButtonElement;
}

beforeEach(() => {
  useViewerStore.setState({ sidebarActivePanel: 'properties' });
});

afterEach(() => {
  cleanup();
  useViewerStore.setState({ sidebarActivePanel: 'properties' });
});

describe('ViewTab — Lighting button opens the Environment side panel (#5506)', () => {
  it('docks the environment panel in the sidebar on first click', () => {
    const container = render(<ViewTab />);
    click(lightingButton(container));
    assert.strictEqual(useViewerStore.getState().sidebarActivePanel, 'environment');
  });

  it('re-docks the Information panel on a second click (toggle-off, #1208 semantics)', () => {
    const container = render(<ViewTab />);
    const button = lightingButton(container);
    click(button);
    assert.strictEqual(useViewerStore.getState().sidebarActivePanel, 'environment');
    click(button);
    assert.strictEqual(useViewerStore.getState().sidebarActivePanel, 'properties');
  });
});
