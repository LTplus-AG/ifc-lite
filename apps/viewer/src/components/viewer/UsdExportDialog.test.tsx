/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { posthog } from '@/lib/analytics';
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
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

function renderDialog(surface: 'classic' | 'ribbon' | 'palette' = 'classic'): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<UsdExportDialog surface={surface} />);
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
    unmountAll();
    useViewerStore.setState({ models: new Map([['model-1', makeModel()]]) });
  });

  it('drives IfcAPI.exportUsd and disposes the WASM handle on the success path', async () => {
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const exportMock = mock.method(GeometryProcessor.prototype, 'exportUsd', () =>
      new TextEncoder().encode('#usda 1.0\n'),
    );
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    const completions: Record<string, unknown>[] = [];
    const analytics = mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      if (event === 'export_completed') completions.push(properties);
    });
    try {
      for (const [index, surface] of (['classic', 'ribbon', 'palette'] as const).entries()) {
        const container = renderDialog(surface);
        await clickExport(container);
        assert.equal(exportMock.mock.callCount(), index + 1, 'one exporter call per successful download');
        assert.equal(disposeMock.mock.callCount(), index + 1, 'dispose runs once per successful download');
        assert.equal(completions.length, index + 1, '#5844: one completion per successful USDA download');
        assert.equal(completions[index].surface, surface);
        assert.equal(completions[index].format, 'usda');
        unmountAll();
      }
    } finally {
      initMock.mock.restore();
      exportMock.mock.restore();
      disposeMock.mock.restore();
      analytics.mock.restore();
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

/**
 * #5605: the USD dialog passed `setOpen` straight to Radix, so Escape (and an
 * outside press, which funnels through the same `onOpenChange(false)`) closed
 * it mid-export, Cancel stayed clickable, and a reopened dialog still showed
 * the previous run's result. The export is pinned in flight by an `init()`
 * that never settles.
 */
describe('UsdExportDialog open guard (#5605)', () => {
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
      (el) => el.textContent?.trim() === 'Export USD (OpenUSD)',
    );
  }

  function cancelButton(): HTMLButtonElement | undefined {
    return [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel');
  }

  async function pressEscape(): Promise<void> {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
  }

  it('keeps the dialog open on Escape and disables Cancel while an export is in flight', async () => {
    const initMock = mock.method(GeometryProcessor.prototype, 'init', () => new Promise(() => {}));
    try {
      const container = renderDialog();
      await clickExport(container);
      assert.equal(dialogIsOpen(), true, 'precondition: the dialog is open with an export running');
      assert.equal(cancelButton()?.disabled, true, 'Cancel must be disabled mid-export');

      await pressEscape();

      assert.equal(dialogIsOpen(), true, 'Escape must not close the dialog mid-export');
    } finally {
      initMock.mock.restore();
    }
  });

  it('clears the previous run\'s result when the dialog is reopened', async () => {
    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const exportMock = mock.method(GeometryProcessor.prototype, 'exportUsd', () => null);
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    const alerts = () => [...document.body.querySelectorAll('[role="alert"]')];
    try {
      const container = renderDialog();
      await clickExport(container);
      assert.equal(alerts().length, 1, 'precondition: the failed run shows its error');

      await pressEscape();
      assert.equal(dialogIsOpen(), false, 'an idle dialog still closes on Escape');

      const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Export USD'));
      assert.ok(trigger, 'trigger button must render');
      await act(async () => {
        trigger.click();
      });
      assert.equal(dialogIsOpen(), true, 'precondition: the dialog reopened');
      assert.equal(alerts().length, 0, 'a reopened dialog must not show the previous run\'s error');
    } finally {
      initMock.mock.restore();
      exportMock.mock.restore();
      disposeMock.mock.restore();
    }
  });
});
