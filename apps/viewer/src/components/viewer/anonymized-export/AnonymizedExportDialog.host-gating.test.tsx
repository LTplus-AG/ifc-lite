/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnonymizedExportDialog` host/trigger gating (#3309 review, Greptile P1 /
 * CodeRabbit Major): the dialog is mounted TWICE in the real app — a
 * trigger-less host in `ViewerLayout.tsx`'s "Global Overlays" (which the
 * context menu and Command Palette target, since they only flip
 * `anonymizedExportRequested`) and a triggered instance registered as an
 * `ExportDialogCommand` in `toolbar/export-commands.ts`. Before the fix,
 * every mounted instance answered to the store flag, so both opened
 * together and both independently captured/restored shared viewer
 * visibility state via `usePreviewIsolation` — the later restore could
 * strand the viewer in the temporary preview isolation. These tests mount
 * both instances at once, as the real app does, and assert on the COUNT of
 * open dialog roots rather than a boolean, since the bug was specifically
 * that count being two instead of one.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { useViewerStore } from '@/store/index.js';
import { AnonymizedExportDialog } from './AnonymizedExportDialog.js';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
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

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Every currently-open Radix dialog root in the document — one per mounted
 *  `<Dialog>` whose `open` is true (Radix unmounts the content when closed,
 *  so this is a true count of what's actually rendered, not a boolean). */
function openDialogRoots(): HTMLElement[] {
  return [...document.body.querySelectorAll('[role="dialog"]')] as HTMLElement[];
}

function cancelButtonWithin(root: Element): HTMLButtonElement {
  const btn = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel');
  assert.ok(btn, 'no Cancel button in this dialog root');
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  unmountAll();
  useViewerStore.setState({
    models: new Map(),
    selectedEntity: null,
    selectedEntityIds: new Set(),
    anonymizedExportRequested: false,
    isolatedEntities: null,
    ghostExceptEntities: null,
    hiddenEntities: new Set(),
  });
});

describe('AnonymizedExportDialog — host/trigger gating (#3309)', () => {
  it('the store flag opens exactly one dialog with both a host and a triggered instance mounted', () => {
    render(
      <>
        <AnonymizedExportDialog />
        <AnonymizedExportDialog trigger={<button type="button">Open via trigger</button>} />
      </>,
    );
    assert.equal(openDialogRoots().length, 0, 'sanity: nothing open before the flag is set');

    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });

    assert.equal(
      openDialogRoots().length,
      1,
      'the store flag (context menu / Command Palette) must open ONLY the trigger-less host, not every mounted instance',
    );
  });

  it('closing a triggered instance does not clear the store flag', () => {
    render(
      <>
        <AnonymizedExportDialog />
        <AnonymizedExportDialog trigger={<button type="button">Open via trigger</button>} />
      </>,
    );

    // The flag is already latched (e.g. a prior context-menu invocation) when
    // the user separately opens the triggered instance from the export
    // dropdown, so both instances are open at once here.
    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });
    assert.equal(openDialogRoots().length, 1, 'sanity: only the host is open so far');

    const triggerButton = [...document.body.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Open via trigger');
    assert.ok(triggerButton, 'no trigger button');
    click(triggerButton!);
    assert.equal(openDialogRoots().length, 2, 'sanity: the triggered instance is now open alongside the host');

    // Radix links a trigger to its own content via aria-controls / matching
    // id once open, so this is the exact dialog root the trigger opened —
    // not "whichever Cancel button comes first in the DOM".
    const contentId = triggerButton!.getAttribute('aria-controls');
    assert.ok(contentId, 'the trigger must point at its own dialog content once open');
    const triggeredRoot = document.getElementById(contentId!);
    assert.ok(triggeredRoot, 'no dialog content matching the trigger');

    click(cancelButtonWithin(triggeredRoot!));

    assert.equal(
      useViewerStore.getState().anonymizedExportRequested,
      true,
      'a triggered instance does not own the store flag; closing it must not clear it',
    );
    assert.equal(openDialogRoots().length, 1, 'the host instance must remain open since the flag is unchanged');
  });

  it('closing the host instance clears the store flag so it cannot re-open the dialog forever', () => {
    render(
      <>
        <AnonymizedExportDialog />
        <AnonymizedExportDialog trigger={<button type="button">Open via trigger</button>} />
      </>,
    );

    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });
    const openRoots = openDialogRoots();
    assert.equal(openRoots.length, 1, 'sanity: only the host opened via the flag');

    click(cancelButtonWithin(openRoots[0]));

    assert.equal(
      useViewerStore.getState().anonymizedExportRequested,
      false,
      'the host must clear the flag on close, or it would immediately re-open the dialog',
    );
    assert.equal(openDialogRoots().length, 0, 'the dialog must actually be closed');
  });
});
