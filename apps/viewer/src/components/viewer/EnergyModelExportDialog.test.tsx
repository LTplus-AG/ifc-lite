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
    ifcDataStore: { source: SOURCE_BYTES, schemaVersion: 'IFC4' } as unknown as FederatedModel['ifcDataStore'],
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

/**
 * Render the dialog opened on a given target. The format picker is a Radix
 * `Select`, which needs `hasPointerCapture` that this DOM harness does not
 * implement, so the target is chosen via `defaultFormat` rather than by
 * simulating the portal-and-keyboard dance. `clickExport` still asserts the
 * footer button reads `Export DFJSON`, so a `defaultFormat` that silently
 * failed to apply would fail the test rather than quietly run HBJSON.
 */
function renderDialog(format: 'HBJSON' | 'DFJSON'): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<EnergyModelExportDialog defaultFormat={format === 'DFJSON' ? 'dfjson' : 'hbjson'} />);
  });
  mounted.push({ root, container });
  return container;
}

/** Open the dialog and press the footer Export button for `format`. */
async function clickExport(container: HTMLElement, format: 'HBJSON' | 'DFJSON'): Promise<void> {
  const trigger = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Energy Model'),
  );
  assert.ok(trigger, 'trigger button must render');
  await act(async () => {
    trigger.click();
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
      const container = renderDialog('HBJSON');
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
      const container = renderDialog('HBJSON');
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
      const container = renderDialog('DFJSON');
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
