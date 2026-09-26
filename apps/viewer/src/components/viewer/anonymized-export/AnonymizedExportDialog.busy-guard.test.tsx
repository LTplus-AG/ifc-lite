/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnonymizedExportDialog` (#5848 follow-up): this dialog's own non-modal,
 * split-preview layout does not fit `ExportDialogShell.tsx`, so it does not
 * inherit `ExportDialogShell.test.tsx`'s coverage of the #5605 close guard
 * and the "clear the previous result" guarantee — it reuses the same
 * `useExportDialogOpenGuard` hook directly (see the component's module
 * docblock), and needs its own proof.
 *
 * `handleExport`'s only `await` (`ensureModelExportReady`) resolves off an
 * already-populated store, so there is no deferred-promise lever to pull from
 * outside without mocking a module (banned, `AGENTS.md`). Instead each
 * assertion below runs SYNCHRONOUSLY, in the same tick as the triggering
 * `click()` (a sync `act()`), before the microtask queue gets a chance to run
 * the awaited continuation — exactly the window `setIsExporting(true)` /
 * `setExportResult(null)` open at the top of `handleExport`, before its first
 * `await`. Deleting the guard/clear line under test collapses that window (or
 * the clear it produces) and the assertion fails.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { AnonymizedExportDialog } from './AnonymizedExportDialog.js';
import { parseFixtureModel, FIXTURE_WALL_A } from './anonymized-export-fixture.test-support.js';

const ID_OFFSET = 1_000_000;
const globalId = (localId: number): number => localId + ID_OFFSET;

function federatedModel(id: string, ifcDataStore: FederatedModel['ifcDataStore']): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 0,
    idOffset: ID_OFFSET,
    maxExpressId: 100_000,
  } as FederatedModel;
}

after(cleanup);

function button(label: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label));
  assert.ok(el, `no button starting with "${label}"`);
  return el as HTMLButtonElement;
}

function alerts(): Element[] {
  return [...document.body.querySelectorAll('[role="alert"]')];
}

function dialogIsOpen(): boolean {
  return document.body.querySelector('#anon-file-stem') !== null;
}

beforeEach(async () => {
  cleanup();
  const store = await parseFixtureModel();
  useViewerStore.setState({
    models: new Map([['m1', federatedModel('m1', store)]]),
    selectedEntity: { modelId: 'm1', expressId: FIXTURE_WALL_A },
    selectedEntityIds: new Set([globalId(FIXTURE_WALL_A)]),
    anonymizedExportRequested: true,
    isolatedEntities: null,
    ghostExceptEntities: null,
    hiddenEntities: new Set(),
  });
});

describe('AnonymizedExportDialog close guard and result clearing (#5848)', () => {
  it('refuses Cancel while an export is in flight, and Cancel disables', async () => {
    render(<AnonymizedExportDialog />);
    assert.ok(dialogIsOpen(), 'precondition: the host-flag path opened the dialog');

    click(button('Export .ifc'));
    // Synchronous window: handleExport's setIsExporting(true) has already
    // flushed; its one `await` has not yet resumed.
    assert.ok(button('Cancel').disabled, 'Cancel must disable the instant export starts');
    click(button('Cancel'));
    assert.ok(dialogIsOpen(), 'Cancel must not close the dialog while busy');

    await waitFor(() => !button('Cancel').disabled, 'the export must finish and release the guard');
  });

  it('refuses Escape while an export is in flight (the guard itself, not just the disabled Cancel button)', async () => {
    render(<AnonymizedExportDialog />);
    click(button('Export .ifc'));
    assert.ok(button('Cancel').disabled, 'precondition: export is in flight');

    // Escape reaches Radix's onOpenChange directly — it never goes through
    // the (disabled) Cancel button, so this is the guard's OWN refusal, not
    // an artifact of the button being unclickable.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.ok(dialogIsOpen(), 'Escape must not close the dialog while busy');

    await waitFor(() => !button('Cancel').disabled, 'the export must finish and release the guard');
  });

  it('clears the previous run\'s result when the dialog is reopened', async () => {
    render(<AnonymizedExportDialog />);
    click(button('Export .ifc'));
    await waitFor(() => alerts().length === 1, 'the first run must render its result');

    act(() => { useViewerStore.getState().setAnonymizedExportRequested(false); });
    assert.equal(dialogIsOpen(), false, 'precondition: the host instance closed');

    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });
    assert.ok(dialogIsOpen(), 'precondition: the dialog reopened');
    assert.equal(alerts().length, 0, 'a reopened dialog must not show the previous run\'s result');
  });

  it('clears the previous result the instant another export starts', async () => {
    render(<AnonymizedExportDialog />);
    click(button('Export .ifc'));
    await waitFor(() => alerts().length === 1, 'the first run must render its result');

    click(button('Export .ifc'));
    // Same synchronous window as the busy-guard test above.
    assert.equal(alerts().length, 0, 'the previous result must clear the instant the next export starts');

    await waitFor(() => !button('Cancel').disabled, 'the second export must finish');
  });
});
