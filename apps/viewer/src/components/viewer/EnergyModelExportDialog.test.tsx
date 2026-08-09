/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ported from `HbjsonExportDialog.test.tsx` (#1956) when that dialog was
 * replaced by the unified energy-model dialog. The disposal contract is
 * per-format, so both HBJSON and DFJSON are covered: the DFJSON branch is the
 * one that never had a `try/finally` at all before this change.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { contiguousSourceBytes } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { EnergyModelExportDialog } from './EnergyModelExportDialog.js';

const SOURCE_BYTES = new Uint8Array([1, 2, 3]);

function makeModel(): FederatedModel {
  return {
    id: 'model-1',
    name: 'model-1.ifc',
    // The unified dialog lists models by `ifcDataStore`, and an unedited model
    // exports its retained `source` bytes verbatim — so the store must carry
    // them for the raw-bytes path to reach the geometry engine at all.
    // `IfcDataStore.source` is an `IfcSourceBytes` accessor (#2183), not a bare
    // Uint8Array: the unedited path borrows it via `withMaterializedAsync`, so a
    // plain array here would make every export throw instead of reaching the
    // geometry engine.
    ifcDataStore: {
      source: contiguousSourceBytes(SOURCE_BYTES),
      schemaVersion: 'IFC4',
    } as unknown as FederatedModel['ifcDataStore'],
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    sourceFile: new File([SOURCE_BYTES], 'model-1.ifc'),
    idOffset: 0,
    maxExpressId: 0,
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderDialog(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<EnergyModelExportDialog />);
  });
  mounted.push({ root, container });
  return container;
}

/**
 * Open the dialog, pick `format` on the segmented control, then press Export.
 *
 * The format picker is a plain segmented group of `<button>`s (only the model
 * selector is a Radix `Select`), so the real control is driven here rather
 * than a test-only prop. The footer button is matched on its exact
 * `Export DFJSON` / `Export HBJSON` label, so a segmented click that failed to
 * switch format fails the test instead of silently exporting the other one.
 */
async function clickExport(container: HTMLElement, format: 'HBJSON' | 'DFJSON'): Promise<void> {
  const trigger = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Energy Model'),
  );
  assert.ok(trigger, 'trigger button must render');
  await act(async () => {
    trigger.click();
  });

  const formatButton = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === format,
  );
  assert.ok(formatButton, `the "${format}" segmented option must render`);
  await act(async () => {
    formatButton.click();
  });

  const exportButton = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === `Export ${format}`,
  );
  assert.ok(exportButton, `the dialog "Export ${format}" button must render once opened`);
  await act(async () => {
    exportButton.click();
  });
}

describe('EnergyModelExportDialog WASM disposal', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    useViewerStore.setState({ models: new Map([['model-1', makeModel()]]) });
  });

  it('disposes the GeometryProcessor WASM handle on the HBJSON success path', async () => {
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const exportMock = mock.method(GeometryProcessor.prototype, 'exportHbjson', () =>
      new TextEncoder().encode('{"rooms":[]}'),
    );
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    try {
      const container = renderDialog();
      await clickExport(container, 'HBJSON');
      assert.equal(disposeMock.mock.callCount(), 1, 'dispose runs exactly once on success');
      assert.equal(exportMock.mock.callCount(), 1, 'the HBJSON exporter actually ran');
    } finally {
      initMock.mock.restore();
      exportMock.mock.restore();
      disposeMock.mock.restore();
    }
  });

  it('disposes the GeometryProcessor WASM handle when exportHbjson returns null (throw path)', async () => {
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    // Mirrors the real "geometry engine unavailable" case: exportHbjson
    // returning null makes handleExport's own `throw new Error(...)` fire —
    // the early-return-via-throw the inner try/finally must cover.
    const exportMock = mock.method(GeometryProcessor.prototype, 'exportHbjson', () => null);
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    try {
      const container = renderDialog();
      await clickExport(container, 'HBJSON');
      assert.equal(disposeMock.mock.callCount(), 1, 'dispose runs exactly once even though export threw');
    } finally {
      initMock.mock.restore();
      exportMock.mock.restore();
      disposeMock.mock.restore();
    }
  });

  it('disposes the GeometryProcessor WASM handle on the DFJSON throw path', async () => {
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const exportMock = mock.method(GeometryProcessor.prototype, 'exportDfjson', () => null);
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    try {
      const container = renderDialog();
      await clickExport(container, 'DFJSON');
      assert.equal(exportMock.mock.callCount(), 1, 'the DFJSON exporter actually ran');
      assert.equal(disposeMock.mock.callCount(), 1, 'dispose runs exactly once even though export threw');
    } finally {
      initMock.mock.restore();
      exportMock.mock.restore();
      disposeMock.mock.restore();
    }
  });
});

/**
 * Radix fires `onOpenChange(false)` for Escape and for an outside pointer
 * press. Both bypass the footer buttons that `isExporting` disables, so before
 * the guard either gesture unmounted the dialog while `handleExport` was still
 * running -- discarding the spinner and the success/failure result.
 *
 * The export is pinned in flight by making `init()` return a promise that never
 * settles, which is what keeps `isExporting` true for the assertions.
 */
describe('EnergyModelExportDialog dismissal during an active export', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    useViewerStore.setState({ models: new Map([['model-1', makeModel()]]) });
  });

  function dialogIsOpen(): boolean {
    return [...document.body.querySelectorAll('*')].some(
      (el) => el.textContent?.trim() === 'Export Energy Model',
    );
  }

  async function pressEscape(): Promise<void> {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
  }

  it('ignores Escape while an export is in flight', async () => {
    const initMock = mock.method(GeometryProcessor.prototype, 'init', () => new Promise(() => {}));
    try {
      const container = renderDialog();
      await clickExport(container, 'HBJSON');
      assert.equal(dialogIsOpen(), true, 'precondition: the dialog is open with an export running');

      await pressEscape();

      assert.equal(dialogIsOpen(), true, 'Escape must not close the dialog mid-export');
    } finally {
      initMock.mock.restore();
    }
  });

  /*
   * The outside-pointer path is deliberately NOT tested here. Radix arms that
   * listener in a `setTimeout` and routes it through its own DismissableLayer
   * bookkeeping, and this jsdom harness does not reproduce it: a test asserting
   * the dialog survives an outside press passed with the guard REMOVED, both
   * with a bare `document.body` dispatch and with a flushed pointerdown/up aimed
   * at an element outside the content. It asserted nothing, so it is gone rather
   * than committed green and misleading.
   *
   * The guard itself is not untested by that. Escape and outside-press funnel
   * through the SAME `onOpenChange` branch -- one `if (!next && isExporting)` --
   * and the Escape case below drives it for real. What is unproven is Radix's
   * outside-press plumbing, which is Radix's contract, not ours.
   */

  /**
   * The control. Without it, both assertions above would also pass on a dialog
   * that had simply been made impossible to dismiss -- and a guard that never
   * releases is a worse bug than the one being fixed.
   */
  it('still closes on Escape once no export is running', async () => {
    const container = renderDialog();
    const trigger = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Energy Model'),
    );
    assert.ok(trigger, 'trigger button must render');
    await act(async () => {
      trigger.click();
    });
    assert.equal(dialogIsOpen(), true, 'precondition: the dialog opened, with nothing exporting');

    await pressEscape();

    assert.equal(dialogIsOpen(), false, 'Escape must still close an idle dialog');
  });
});
