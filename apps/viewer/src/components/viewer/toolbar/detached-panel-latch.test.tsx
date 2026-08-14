/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A detached panel is still an OPEN panel, and the toolbars must say so.
 *
 * A workspace panel lives in exactly one of four places — docked, floating,
 * popped out to an OS window, or closed (`hooks/usePanelControls.ts`). The
 * toolbars only ever read the DOCK FLAGS, which is a different question, and
 * the two answers come apart the moment a panel is detached:
 *
 *  - `floatPanel` adds to `floatingPanels` and leaves the dock flag alone
 *    (`store/slices/dockSlice.ts`), so a floating panel still reads "docked"
 *    until something clears the flag...
 *  - ...and `registerSidebarExclusivity` clears it the instant ANY other panel
 *    docks (`store/index.ts`), without touching the float channel. The panel is
 *    now on screen with every toolbar latch dark.
 *
 * The activity bar never had this bug because it asks `panelLocation`. These
 * tests pin the same answer for the shared toolbar hook, at the level a user
 * meets it: the latch, and what a click on a detached panel does.
 *
 * The bottom-strip half is the one with teeth. The hook used to re-derive the
 * flag flips instead of calling the store's `toggleBottomPanel`, so it never
 * ran the float / pop-out cleanup — clicking a floating Lists panel cleared its
 * flag and left the window orphaned on screen. It could not simply delegate,
 * because it spelled the panel `'list'` where the registry and store spell it
 * `'lists'`; the id drift is why the duplicate existed at all.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useWorkspacePanelControls } from './useWorkspacePanelControls.js';

/** Mounts the shared hook and exposes its latest value to the test. */
function mountHook(): { current: ReturnType<typeof useWorkspacePanelControls> } {
  const ref = { current: null as unknown as ReturnType<typeof useWorkspacePanelControls> };
  function Probe() {
    ref.current = useWorkspacePanelControls();
    return null;
  }
  render(<Probe />);
  return ref;
}

/** The docked-panel flags this file drives, back to their initial state. */
function resetPanels(): void {
  useViewerStore.setState({
    bcfPanelVisible: false,
    idsPanelVisible: false,
    listPanelVisible: false,
    sourcesPanelVisible: false,
    scriptPanelVisible: false,
    ganttPanelVisible: false,
    floatingPanels: [],
    poppedOutIds: [],
  });
}

describe('a detached panel reads as open on the toolbars', () => {
  beforeEach(resetPanels);
  afterEach(() => {
    cleanup();
    resetPanels();
  });

  it('keeps BCF latched while it floats and another panel takes the dock', () => {
    const hook = mountHook();

    // Open BCF, float it, then dock IDS — the exclusivity subscriber clears
    // BCF's flag on the way, which is exactly the state that used to go dark.
    act(() => {
      useViewerStore.getState().setBcfPanelVisible(true);
      useViewerStore.getState().floatPanel('bcf');
      useViewerStore.getState().setIdsPanelVisible(true);
    });

    assert.equal(
      useViewerStore.getState().bcfPanelVisible,
      false,
      'precondition: docking IDS should have cleared the BCF dock flag',
    );
    assert.ok(
      useViewerStore.getState().floatingPanels.some((p) => p.id === 'bcf'),
      'precondition: the BCF panel should still be floating on screen',
    );
    assert.ok(hook.current.activeWorkspacePanels.has('bcf'), 'the floating BCF panel reads as closed');
  });

  it('keeps a popped-out panel latched', () => {
    const hook = mountHook();

    act(() => { useViewerStore.setState({ poppedOutIds: ['compare'] }); });

    assert.ok(hook.current.activeWorkspacePanels.has('compare'), 'the popped-out panel reads as closed');
  });

  it('brings a floating side panel home instead of closing it out from under its window', () => {
    const hook = mountHook();

    act(() => {
      useViewerStore.getState().setSourcesPanelVisible(true);
      useViewerStore.getState().floatPanel('sources');
    });

    // The dock flag is still set while the panel floats, so negating it read as
    // "close" and the detach cleanup then tore the panel down — the rail, which
    // asks whether the panel owns the DOCKED slot, re-docks instead.
    act(() => { hook.current.handleToggleRightPanel('sources'); });

    assert.deepEqual(
      useViewerStore.getState().floatingPanels.map((p) => p.id),
      [],
      'the floating window should be gone, re-docked rather than left behind',
    );
    assert.equal(
      useViewerStore.getState().sourcesPanelVisible,
      true,
      'Cloud sources should be docked after the toggle, not closed back to Information',
    );
  });

  it('still closes a docked side panel on the second toggle', () => {
    const hook = mountHook();

    act(() => { hook.current.handleToggleRightPanel('sources'); });
    assert.equal(useViewerStore.getState().sourcesPanelVisible, true, 'first toggle did not open Cloud sources');

    act(() => { hook.current.handleToggleRightPanel('sources'); });
    assert.equal(useViewerStore.getState().sourcesPanelVisible, false, 'second toggle did not close Cloud sources');
  });

  it('brings a floating Lists panel home instead of orphaning it', () => {
    const hook = mountHook();

    act(() => {
      useViewerStore.getState().setListPanelVisible(true);
      useViewerStore.getState().floatPanel('lists');
    });

    act(() => { hook.current.handleToggleBottomPanel('lists'); });

    assert.deepEqual(
      useViewerStore.getState().floatingPanels.map((p) => p.id),
      [],
      'the floating Lists window was left on screen',
    );
    assert.equal(
      useViewerStore.getState().listPanelVisible,
      true,
      'Lists should be docked after the toggle, not closed out from under its own window',
    );
  });

  it('still closes a docked bottom panel on the second toggle', () => {
    const hook = mountHook();

    act(() => { hook.current.handleToggleBottomPanel('lists'); });
    assert.equal(useViewerStore.getState().listPanelVisible, true, 'first toggle did not open Lists');

    act(() => { hook.current.handleToggleBottomPanel('lists'); });
    assert.equal(useViewerStore.getState().listPanelVisible, false, 'second toggle did not close Lists');
  });

  it('keeps the bottom strip single-tenant', () => {
    const hook = mountHook();

    act(() => { hook.current.handleToggleBottomPanel('script'); });
    act(() => { hook.current.handleToggleBottomPanel('gantt'); });

    const s = useViewerStore.getState();
    assert.equal(s.ganttPanelVisible, true, 'Schedule did not open');
    assert.equal(s.scriptPanelVisible, false, 'Script stayed open alongside Schedule');
  });
});
