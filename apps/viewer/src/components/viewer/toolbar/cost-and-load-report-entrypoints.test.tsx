/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reachability guard for the Cost and Load Report toolbar entries (#5032).
 *
 * Cost (#4858) shipped with no toolbar entry point — the ActivityBar rail was
 * its only way in, the same failure class as Location Zones before #2508.
 *
 * These mount the ribbon `AnalyzeTab`, click the controls the way a user would,
 * and read `sidebarActivePanel` back — pinning its reachability and that the shared
 * `useWorkspacePanelControls` hook reports them as open with the right
 * label.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { resolve } from '@/i18n/registry';
import { panelTitleKey } from '@/lib/panels/registry';
import { useViewerStore } from '@/store';
import { useWorkspacePanelControls } from './useWorkspacePanelControls.js';
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

function ribbonButton(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('button')].filter(
    (e) => e.getAttribute('aria-label') === label,
  );
  assert.equal(found.length, 1, `expected one ribbon button named "${label}", found ${found.length}`);
  return found[0];
}

describe('#5032 Load Report + Cost toolbar reachability', () => {
  afterEach(() => {
    unmountExtras();
    useViewerStore.getState().showWorkspacePanel('properties');
  });

  it('the ribbon Analyze tab opens Cost', () => {
    const container = mount(<AnalyzeTab />);
    clickEl(ribbonButton(container, resolve(panelTitleKey('cost'))));
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
    assert.equal(probe.workspacePanelLabel, resolve(panelTitleKey('cost')));
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
    assert.equal(probe.workspacePanelLabel, resolve(panelTitleKey('loadReport')));
  });
});
