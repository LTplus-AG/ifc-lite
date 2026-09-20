/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reachability guard for the Cost and Load Report toolbar entries (#5032).
 *
 * Load Report (#3927) shipped as a ribbon-only Analyze button with no
 * classic Panels-menu entry. Cost (#4858) shipped with no toolbar entry
 * point at all on either surface — the ActivityBar rail was its only way
 * in, the same failure class as Location Zones before #2508.
 *
 * These mount the real `MainToolbar` and ribbon `AnalyzeTab`, click the
 * controls the way a user would, and read `sidebarActivePanel` back —
 * pinning that both surfaces now reach both panels, and that the shared
 * `useWorkspacePanelControls` hook reports them as open with the right
 * label.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { useWorkspacePanelControls } from './useWorkspacePanelControls.js';
import { MainToolbar } from '../MainToolbar.js';
import { AnalyzeTab } from '../ribbon/tabs/AnalyzeTab.js';

const extraMounts: Array<{ root: Root; container: HTMLElement }> = [];

function mount(node: ReactNode): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const r = createRoot(el);
  act(() => r.render(<TooltipProvider>{node}</TooltipProvider>));
  extraMounts.push({ root: r, container: el });
  return el;
}

function unmountExtras(): void {
  for (const { root: r, container: el } of extraMounts.splice(0)) {
    act(() => r.unmount());
    el.remove();
  }
}

function clickEl(element: Element): void {
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
}

/** Radix opens the Panels dropdown on `pointerdown`, not `click`. */
function openPanelsMenu(container: HTMLElement): void {
  const trigger = [...container.querySelectorAll('button')].find((b) =>
    /Panels/i.test(b.textContent ?? '') || /Panels/i.test(b.getAttribute('aria-label') ?? ''),
  );
  assert.ok(trigger, 'the classic strip must have a Panels menu');
  act(() => {
    trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 } as PointerEventInit));
  });
  clickEl(trigger);
}

function classicMenuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].filter(
    (e) => e.textContent?.trim() === label,
  );
  assert.equal(found.length, 1, `expected one classic Panels menu item labelled "${label}", found ${found.length}`);
  return found[0];
}

function ribbonButton(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('button')].filter(
    (e) => e.textContent?.trim() === label,
  );
  assert.equal(found.length, 1, `expected one ribbon button labelled "${label}", found ${found.length}`);
  return found[0];
}

describe('#5032 Load Report + Cost toolbar reachability', () => {
  afterEach(() => {
    unmountExtras();
    useViewerStore.getState().showWorkspacePanel('properties');
  });

  it('the classic Panels dropdown opens Load Report', () => {
    const container = mount(<MainToolbar />);
    openPanelsMenu(container);
    clickEl(classicMenuItem('Load Report'));
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'loadReport');
  });

  it('the classic Panels dropdown opens Cost', () => {
    const container = mount(<MainToolbar />);
    openPanelsMenu(container);
    clickEl(classicMenuItem('Cost'));
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'cost');
  });

  it('the ribbon Analyze tab opens Cost', () => {
    const container = mount(<AnalyzeTab />);
    clickEl(ribbonButton(container, 'Cost'));
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'cost');
  });

  it('the shared hook reports Cost as active with its own label, not a fallback', () => {
    function Probe() {
      const controls = useWorkspacePanelControls();
      probe = controls;
      return null;
    }
    let probe!: ReturnType<typeof useWorkspacePanelControls>;
    mount(<Probe />);

    act(() => { useViewerStore.getState().toggleWorkspacePanel('cost'); });
    assert.ok(probe.activeWorkspacePanels.has('cost'), 'Cost must read as an active workspace panel once docked');
    assert.equal(probe.workspacePanelLabel, 'Cost');
  });

  it('the shared hook reports Load Report as active with its own label, not a fallback', () => {
    function Probe() {
      const controls = useWorkspacePanelControls();
      probe = controls;
      return null;
    }
    let probe!: ReturnType<typeof useWorkspacePanelControls>;
    mount(<Probe />);

    act(() => { useViewerStore.getState().toggleWorkspacePanel('loadReport'); });
    assert.ok(probe.activeWorkspacePanels.has('loadReport'), 'Load Report must read as an active workspace panel once docked');
    assert.equal(probe.workspacePanelLabel, 'Load Report');
  });
});
