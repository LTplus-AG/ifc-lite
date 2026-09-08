/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cloud sources is reachable from every surface that opens a panel.
 *
 * The `sources` panel (CDE integrations) shipped with the ActivityBar rail as
 * its only entry point — the same gap Location zones had before #2508. The
 * store-symbol parity guard (`../toolbar-parity.test.ts`) cannot see that class
 * of hole and says so: both toolbars already reach `toggleWorkspacePanel` and
 * the panel flags for OTHER panels, so a panel missing from both surfaces
 * leaves the two symbol sets identical and the diff empty.
 *
 * There are THREE such surfaces, not two, and that is the trap this file exists
 * for: Location zones was wired into both toolbars and still never reached the
 * command palette, so "fixed on both toolbars" read as done while a third door
 * stayed shut. A panel is only as reachable as the last surface that learned
 * about it.
 *
 * So this asserts the OUTPUT: click the control each surface ships and check the
 * panel actually opened. A control rendered but not wired, or wired to a handler
 * that no longer flips the flag, fails here — presence would not.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { render, click, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { FileTab } from '../ribbon/tabs/FileTab.js';
import { MainToolbar } from '../MainToolbar.js';
import { CommandPalette } from '../CommandPalette.js';
import { BimProvider } from '@/sdk/BimProvider';
import type { FileCommands } from './useFileCommands.js';

/** Typed rather than cast, so the shape cannot drift underneath the mount. */
const FILE_COMMANDS: FileCommands = {
  fileInputs: null,
  openShareDialog: () => {},
  handleOpenClick: async () => {},
  handleAddModelClick: async () => {},
  handleRefresh: async () => {},
  canRefresh: false,
  hasModelsLoaded: true,
};

/**
 * `RibbonLargeButton` / the classic menu items both label themselves for the
 * accessibility tree, which is also how a user finds them. Radix portals menu
 * content onto `document.body`, so query there rather than in the container.
 */
function byAccessibleName(name: string | RegExp): HTMLElement {
  const match = [...document.body.querySelectorAll<HTMLElement>('[aria-label], [role="menuitemcheckbox"]')]
    .find((el) => {
      const label = el.getAttribute('aria-label') ?? el.textContent ?? '';
      return typeof name === 'string' ? label === name : name.test(label);
    });
  assert.ok(match, `no control named ${String(name)} on screen`);
  return match;
}

/** Radix opens a dropdown on pointerdown, not click. */
function openMenu(trigger: HTMLElement): void {
  act(() => {
    trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  });
  click(trigger);
}

describe('Cloud sources is reachable from both toolbar styles', () => {
  beforeEach(() => {
    useViewerStore.setState({ sourcesPanelVisible: false });
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState({ sourcesPanelVisible: false });
  });

  it('opens and closes the panel from the ribbon File tab', () => {
    render(<FileTab fileCommands={FILE_COMMANDS} />);

    const button = byAccessibleName(/^Cloud sources/);
    click(button);
    assert.equal(useViewerStore.getState().sourcesPanelVisible, true, 'first click did not open the panel');

    click(button);
    assert.equal(useViewerStore.getState().sourcesPanelVisible, false, 'second click did not close the panel');
  });

  it('opens the panel from the classic strip Panels menu', () => {
    render(<MainToolbar />);

    openMenu(byAccessibleName('Panels'));
    click(byAccessibleName(/Cloud Sources/));

    assert.equal(useViewerStore.getState().sourcesPanelVisible, true, 'the Panels menu item did not open the panel');
  });

  it('opens the panel from the command palette', async () => {
    const container = render(
      <BimProvider>
        <CommandPalette open onOpenChange={() => {}} />
      </BimProvider>,
    );

    const row = [...container.ownerDocument.body.querySelectorAll<HTMLElement>('[role="option"], button')]
      .find((el) => el.textContent?.includes('Cloud Sources'));
    assert.ok(row, 'the palette lists no Cloud Sources command');
    click(row);
    // `runCommand` defers to `requestAnimationFrame` (a file-dialog quirk), so
    // the action has NOT run when click() returns. Let the frame land.
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });

    assert.equal(useViewerStore.getState().sourcesPanelVisible, true, 'the palette command did not open the panel');
  });
});
