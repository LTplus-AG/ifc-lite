/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { toast } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ExportChangesButton } from './ExportChangesButton.js';

function makeModel(): FederatedModel {
  return {
    id: 'model-1',
    name: 'model-1.ifc',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    sourceFile: new File([new Uint8Array([1, 2, 3])], 'model-1.ifc'),
    idOffset: 0,
    maxExpressId: 0,
  };
}

/** A view with one base pset property so an edit has a real previous -> new pair to compare. */
function makeView(): MutablePropertyView {
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor((entityId) => entityId === 7 ? [{
    name: 'Pset_Base',
    globalId: 'g',
    properties: [{ name: 'Status', type: PropertyValueType.Label, value: 'Original' }],
  }] : []);
  return view;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderButton(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TooltipProvider>
        <ExportChangesButton />
      </TooltipProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

/** The toolbar trigger — distinguishable from the dialog's own "Export" button by its badge text. */
function findToolbarButton(container: HTMLElement): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Export Changes'));
  assert.ok(btn, 'toolbar "Export Changes" button must render');
  return btn;
}

/** The dialog's confirm button — Radix portals it into `document.body`. */
function findDialogExportButton(): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.includes('Export') && !b.textContent?.includes('Export Changes'),
  );
  assert.ok(btn, 'the dialog Export (confirm) button must render once the review is open');
  return btn;
}

function dialogText(): string {
  return document.body.textContent ?? '';
}

describe('ExportChangesButton — review/export divergence (issue: detect-and-require re-review)', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    useViewerStore.setState({
      models: new Map([['model-1', makeModel()]]),
      mutationViews: new Map(),
      mutationVersion: 0,
      georefMutations: new Map(),
      scheduleData: null,
      scheduleIsEdited: false,
      scheduleSourceModelId: null,
      ifcDataStore: null,
    });
  });

  it('refuses to export and keeps the dialog open when the overlay changes while the review is open, bypassing tracked set()', async () => {
    const view = makeView();
    view.setProperty(7, 'Pset_Base', 'Status', 'Edited', PropertyValueType.Label);
    useViewerStore.setState({
      models: new Map([['model-1', makeModel()]]),
      mutationViews: new Map([['model-1', view]]),
    });

    const errorMock = mock.method(toast, 'error', () => {});
    const successMock = mock.method(toast, 'success', () => {});
    const infoMock = mock.method(toast, 'info', () => {});

    try {
      const container = renderButton();

      // Open the review — this snapshots `groups` from the overlay as it
      // stands right now ("Edited").
      await act(async () => {
        findToolbarButton(container).click();
      });
      assert.ok(dialogText().includes('Edited'), 'review shows the property value at open time');

      // Mutate the SAME MutablePropertyView instance directly — bypassing
      // every store action's tracked `set()`, so `mutationVersion` does not
      // bump and the dialog does not re-render. This is the reproduction:
      // the export button's own `changed`/`groups` memo depends on
      // `mutationVersion`, so this change is invisible to React but very
      // visible to `getEffectiveChanges()` at click time.
      view.setProperty(7, 'Pset_Base', 'Status', 'Sneaky', PropertyValueType.Label);

      // Confirm from the (still stale-looking) dialog.
      await act(async () => {
        findDialogExportButton().click();
      });

      assert.equal(errorMock.mock.callCount(), 1, 'a refusal toast fires exactly once');
      assert.equal(
        errorMock.mock.calls[0].arguments[0],
        'Changes were made since you opened this review — check the updated list and confirm again.',
      );
      assert.equal(successMock.mock.callCount(), 0, 'export never reports success');
      assert.equal(infoMock.mock.callCount(), 0, 'export never reports "no changes" either — it never ran');

      // The dialog must still be open (export was refused, not silently
      // applied to the stale list) so the user can see the updated content.
      assert.ok(dialogText().includes('Review changes'), 'the review dialog remains open after a refused confirm');
    } finally {
      errorMock.mock.restore();
      successMock.mock.restore();
      infoMock.mock.restore();
    }
  });

  it('proceeds past the review (does not refuse) when nothing changes between opening it and confirming', async () => {
    const view = makeView();
    view.setProperty(7, 'Pset_Base', 'Status', 'Edited', PropertyValueType.Label);
    useViewerStore.setState({
      models: new Map([['model-1', makeModel()]]),
      mutationViews: new Map([['model-1', view]]),
    });

    const errorMock = mock.method(toast, 'error', () => {});

    try {
      const container = renderButton();

      await act(async () => {
        findToolbarButton(container).click();
      });
      assert.ok(dialogText().includes('Edited'), 'review shows the property value at open time');

      await act(async () => {
        findDialogExportButton().click();
        // Flush the microtasks `handleExport`'s real (data-store-less, so
        // fast-failing) export attempt runs after the synchronous
        // `setReviewOpen(false)` this test cares about, so its later state
        // updates don't leak past this `act()` as unwrapped warnings.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Confirming with no divergence closes the review dialog synchronously
      // (`setReviewOpen(false)` runs before `handleExport`'s own async work) —
      // that's the signal the match path was taken, independent of whatever
      // the real exporter (unavailable/mocked in this test environment) does
      // with a data-store-less model afterward.
      assert.ok(!dialogText().includes('Review changes'), 'the review dialog closes once confirmed');
      const refusal = errorMock.mock.calls.find(
        (c) => c.arguments[0] === 'Changes were made since you opened this review — check the updated list and confirm again.',
      );
      assert.equal(refusal, undefined, 'no stale-review refusal when nothing changed since the review opened');
    } finally {
      errorMock.mock.restore();
    }
  });
});
