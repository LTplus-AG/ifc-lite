/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bottom-strip header (#5498): a tab row for the bottom panels opened
 * this session, the detach grip, maximize/restore, and Close. Covers the
 * issue's "done when": switching tabs keeps each panel's state, maximize /
 * restore, and closing a tab clears the right flag — plus the tabs and the
 * resize height persisting across a remount.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef } from 'react';
import { advance, cleanup, click, mouseDown, press, render } from '@/test/render.js';
import { installLayout } from '@/test/dom-layout.js';
import { useViewerStore } from '@/store';
import { usePanelControls } from '@/hooks/usePanelControls';
import { activeBottomPanel, bottomPanelFlags } from '@/lib/panels/bottom-panels';
import { useBottomPanelFlags } from '@/hooks/useBottomPanelFlags';
import { loadBottomStripHeight, loadBottomStripTabs, persistBottomStripHeight } from '@/lib/panels/bottom-strip-persistence';
import { blankDocument } from '@/lib/document/presets';
import { BottomStrip } from './BottomStrip';

installLayout();

function Harness() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { closePanel } = usePanelControls();
  const dockedPanel = activeBottomPanel(useBottomPanelFlags());
  return (
    <div ref={containerRef} style={{ height: 800 }}>
      <BottomStrip dockedPanel={dockedPanel} analysisExtension={null} containerRef={containerRef} closePanel={closePanel} />
    </div>
  );
}

function seed(patch: Partial<ReturnType<typeof useViewerStore.getState>>): void {
  useViewerStore.setState({
    ...bottomPanelFlags(null),
    floatingPanels: [],
    poppedOutIds: [],
    documents: [],
    activeDocumentId: null,
    listDefinitions: [],
    ...patch,
  });
}

function tabLabels(ui: HTMLElement): string[] {
  return [...ui.querySelectorAll('[role="tab"]')].map((el) => el.textContent ?? '');
}

beforeEach(() => {
  window.localStorage.clear();
  seed({});
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it('opening a second bottom panel adds a tab; the active tab tracks the exclusive flag', async () => {
  seed(bottomPanelFlags('lists'));
  const ui = render(<Harness />);
  await act(async () => {});
  assert.equal(tabLabels(ui).some((t) => t.includes('Lists')), true, 'Lists opened a tab');

  act(() => useViewerStore.getState().openPanelInHome('document'));
  await act(async () => {});
  const labels = tabLabels(ui);
  assert.equal(labels.some((t) => t.includes('Lists')), true, 'Lists tab stays open in the background');
  assert.equal(labels.some((t) => t.includes('Document')), true, 'Document opened a second tab');

  const activeTab = ui.querySelector('[role="tab"][aria-selected="true"]');
  assert.ok(activeTab?.textContent?.includes('Document'), 'the active tab is the one the exclusive flag shows');
  assert.equal(useViewerStore.getState().listPanelVisible, false, 'opening Document cleared the Lists flag');
});

it('switching tabs re-docks the panel and keeps its state — the document open before the switch is still open after', async () => {
  const doc = blankDocument();
  seed({ ...bottomPanelFlags('document'), documents: [doc], activeDocumentId: doc.id });
  const ui = render(<Harness />);
  await act(async () => {});
  act(() => useViewerStore.getState().openPanelInHome('lists'));
  await act(async () => {});
  assert.equal(useViewerStore.getState().activeDocumentId, doc.id, 'Document\'s own state is untouched while it is in the background');

  const documentTab = [...ui.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes('Document'))!;
  assert.ok(documentTab, 'the Document tab is still in the row');
  mouseDown(documentTab);
  await act(async () => {});
  assert.equal(useViewerStore.getState().documentPanelVisible, true, 'clicking the background tab re-activates it');
  assert.equal(useViewerStore.getState().activeDocumentId, doc.id, 'switching back finds the same document, not a fresh blank one');
});

it('#5815 ArrowLeft selects the preceding bottom tab and labels its panel', async () => {
  seed(bottomPanelFlags('lists'));
  const ui = render(<Harness />);
  await act(async () => {});
  act(() => useViewerStore.getState().openPanelInHome('document'));
  await act(async () => {});
  const tabs = [...ui.querySelectorAll<HTMLElement>('[role="tab"]')];
  assert.equal(tabs.length, 2);
  tabs[1].focus();
  press(tabs[1], 'ArrowLeft');
  await advance(5);
  await act(async () => {});
  assert.equal(useViewerStore.getState().listPanelVisible, true);
  assert.equal(document.activeElement, tabs[0]);
  const panel = ui.querySelector('[role="tabpanel"]');
  assert.ok(panel);
  assert.equal(panel.getAttribute('aria-labelledby'), tabs[0].id);
});

it('closing the active tab promotes a neighbour; closing the last tab clears its flag and empties the strip', async () => {
  seed(bottomPanelFlags('lists'));
  const ui = render(<Harness />);
  await act(async () => {});
  act(() => useViewerStore.getState().openPanelInHome('document'));
  await act(async () => {});

  const closeDocument = ui.querySelector('button[aria-label="Close Document"]');
  assert.ok(closeDocument, 'the Document tab has its own close control');
  click(closeDocument!);
  await act(async () => {});
  assert.equal(useViewerStore.getState().documentPanelVisible, false, 'closing the tab clears its flag');
  assert.equal(useViewerStore.getState().listPanelVisible, true, 'the remaining tab (Lists) is promoted to active');
  assert.equal(tabLabels(ui).some((t) => t.includes('Document')), false, 'the closed tab left the row');

  const closeLists = ui.querySelector('button[aria-label="Close Lists"]');
  click(closeLists!);
  await act(async () => {});
  assert.equal(useViewerStore.getState().listPanelVisible, false, 'closing the last tab clears its flag too');
  assert.equal(ui.querySelector('[role="tablist"]'), null, 'nothing left to dock — the strip unmounts');
});

it('maximize fills the region and restore returns the strip to its resizable height', async () => {
  seed(bottomPanelFlags('lists'));
  const ui = render(<Harness />);
  await act(async () => {});

  const strip = ui.querySelector('[data-detach-root]') as HTMLElement;
  assert.ok(strip.className.includes('relative'), 'starts docked at a fixed height, not maximized');
  assert.ok(ui.querySelector('.cursor-row-resize'), 'the resize handle is present while docked');

  const maximizeButton = ui.querySelector('button[aria-label="Maximize"]');
  assert.ok(maximizeButton, 'the header offers a maximize control');
  click(maximizeButton!);
  await act(async () => {});
  assert.ok(strip.className.includes('absolute inset-0'), 'maximized fills the viewport region');
  assert.equal(ui.querySelector('.cursor-row-resize'), null, 'resizing is disabled while maximized');

  const restoreButton = ui.querySelector('button[aria-label="Restore"]');
  assert.ok(restoreButton, 'the same control now restores');
  click(restoreButton!);
  await act(async () => {});
  assert.ok(strip.className.includes('relative'), 'restore returns to the docked, resizable layout');
  assert.ok(ui.querySelector('.cursor-row-resize'), 'the resize handle is back');
});

it('the opened tabs and the resized height persist across a remount', async () => {
  seed(bottomPanelFlags('lists'));
  const ui = render(<Harness />);
  await act(async () => {});
  act(() => useViewerStore.getState().openPanelInHome('document'));
  await act(async () => {});
  assert.deepEqual(loadBottomStripTabs(), ['lists', 'document'], 'both tabs are persisted as they are opened');

  const handle = ui.querySelector('.cursor-row-resize') as HTMLElement;
  mouseDown(handle, { clientY: 500 });
  await act(async () => {
    document.dispatchEvent(new window.MouseEvent('mousemove', { clientY: 400, bubbles: true }));
  });
  await act(async () => {
    document.dispatchEvent(new window.MouseEvent('mouseup', { clientY: 400, bubbles: true }));
  });
  const persistedHeight = loadBottomStripHeight();
  assert.ok(persistedHeight > 300, `dragging the handle up grew the persisted height (got ${persistedHeight})`);

  cleanup();
  seed(bottomPanelFlags('document'));
  const ui2 = render(<Harness />);
  await act(async () => {});
  assert.equal(tabLabels(ui2).some((t) => t.includes('Lists')), true, 'the remembered Lists tab reappears after a remount');
  const strip2 = ui2.querySelector('[data-detach-root]') as HTMLElement;
  assert.equal(strip2.style.height, `${persistedHeight}px`, 'the remounted strip starts at the persisted height');
});

it('a strip mounted after an earlier "Reset layout" keeps its persisted height (#5957)', async () => {
  // The epoch stays non-zero after the first reset. Comparing it against 0
  // re-applied that old reset on every later mount, discarding the height the
  // user resized to since.
  persistBottomStripHeight(420);
  seed({ ...bottomPanelFlags('lists'), layoutResetEpoch: 1 });
  const ui = render(<Harness />);
  await act(async () => {});
  const strip = ui.querySelector('[data-detach-root]') as HTMLElement;
  assert.equal(strip.style.height, '420px', 'the strip opens at the persisted height');
  assert.equal(loadBottomStripHeight(), 420, 'mounting does not overwrite the persisted height');

  // A reset made while it is mounted still restores the default.
  act(() => useViewerStore.getState().bumpLayoutResetEpoch());
  await act(async () => {});
  assert.notEqual(strip.style.height, '420px', 'a live reset restores the default height');
});
