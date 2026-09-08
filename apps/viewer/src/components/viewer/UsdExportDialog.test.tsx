/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { UsdExportDialog } from './UsdExportDialog.js';

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

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderDialog(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<UsdExportDialog />);
  });
  mounted.push({ root, container });
  return container;
}

async function clickExport(container: HTMLElement): Promise<void> {
  const trigger = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Export USD'),
  );
  assert.ok(trigger, 'trigger button must render');
  await act(async () => {
    trigger.click();
  });

  const exportButton = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.includes('Export') && !b.textContent?.includes('Export USD'),
  );
  assert.ok(exportButton, 'the dialog Export button must render once opened');
  await act(async () => {
    exportButton.click();
  });
}

describe('UsdExportDialog', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    useViewerStore.setState({ models: new Map([['model-1', makeModel()]]) });
  });

  it('drives IfcAPI.exportUsd and disposes the WASM handle on the success path', async () => {
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const exportMock = mock.method(GeometryProcessor.prototype, 'exportUsd', () =>
      new TextEncoder().encode('#usda 1.0\n'),
    );
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    try {
      const container = renderDialog();
      await clickExport(container);
      assert.equal(exportMock.mock.callCount(), 1, 'exportUsd is called exactly once');
      assert.equal(disposeMock.mock.callCount(), 1, 'dispose runs exactly once on success');
    } finally {
      initMock.mock.restore();
      exportMock.mock.restore();
      disposeMock.mock.restore();
    }
  });

  it('disposes the WASM handle even when exportUsd returns null (throw path)', async () => {
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    // A null result makes handleExport's own `throw` fire — the disposal must
    // still run through the inner try/finally.
    const exportMock = mock.method(GeometryProcessor.prototype, 'exportUsd', () => null);
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    try {
      const container = renderDialog();
      await clickExport(container);
      assert.equal(disposeMock.mock.callCount(), 1, 'dispose runs exactly once even though export threw');
    } finally {
      initMock.mock.restore();
      exportMock.mock.restore();
      disposeMock.mock.restore();
    }
  });
});
