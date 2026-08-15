/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rendering tests for `ExtensionExportSlot` — the "appears" half of #1907.
 *
 * The unit tests around #1907/#1930 proved the host dispatches the right
 * exporter, but nothing ever asserted that a registered `exportMenu`
 * contribution actually SHOWS UP in the UI — the original bug was precisely
 * an extension that installed correctly and then displayed nothing. These
 * are the first React rendering tests in `apps/viewer`: happy-dom provides
 * the DOM (registered by `@/test/setup-dom.js`, which must stay the first
 * import), React 19's `createRoot` + `act()` drive the component for real.
 *
 * The host injected through `ExtensionHostContext` is a real
 * `ExtensionHostService` subclass over a real `SlotRegistry` — only
 * `runExporter` is overridden (the genuine one needs a QuickJS sandbox and
 * IndexedDB). Download assertions sit on the browser seams the code
 * actually uses: the bubbling click of the `<a download>` anchor that
 * `downloadFile` dispatches, the `Blob` handed to `URL.createObjectURL`,
 * and the `ifc-lite:file-downloaded` tour event. The tour event alone
 * carries only the file KIND, not the filename or bytes, which is why the
 * anchor + blob seams are asserted too.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExporterContribution, RuntimeRunResult } from '@ifc-lite/extensions';
import { createBimContext } from '@ifc-lite/sdk';
import { ExtensionHostService } from '@/services/extensions/host.js';
import type { ExporterOutput } from '@/services/extensions/host-exporters.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events';
import { ExtensionExportSlot } from './ExtensionExportSlot.js';

// ─── Download-path observers (real seams, no module mocks) ───────────────

/** Anchor clicks observed at the document — `downloadFile`'s real endpoint. */
const anchorClicks: Array<{ download: string; href: string }> = [];
document.addEventListener('click', (event: Event) => {
  const target = event.target;
  if (target instanceof HTMLAnchorElement) {
    // A real browser would start the download; happy-dom would try to
    // navigate to the blob: URL instead, so suppress the default.
    event.preventDefault();
    anchorClicks.push({ download: target.download, href: target.getAttribute('href') ?? '' });
  }
});

/** Blobs handed to `URL.createObjectURL` — lets us read back the bytes. */
const createdBlobs: Blob[] = [];
URL.createObjectURL = (obj: Blob | MediaSource): string => {
  if (!(obj instanceof Blob)) throw new Error('expected downloadFile to produce a Blob');
  createdBlobs.push(obj);
  return `blob:ifc-lite-test-${createdBlobs.length}`;
};
// `downloadBlob` revokes on a 1.5 s timer; our URLs were never real, so
// make revocation a no-op instead of letting happy-dom reject them later.
URL.revokeObjectURL = (): void => {};

/** Kinds reported through the tour event (`emitFileDownloaded`). */
const downloadedKinds: string[] = [];
window.addEventListener(EVENT_FILE_DOWNLOADED, (event: Event) => {
  if (event instanceof CustomEvent) {
    const detail: unknown = event.detail;
    if (typeof detail === 'object' && detail !== null && 'kind' in detail) {
      downloadedKinds.push(String(detail.kind));
    }
  }
});

// ─── Stub host ────────────────────────────────────────────────────────────

/**
 * Real `ExtensionHostService` (so the context's nominal type is satisfied
 * without a cast and `getSlotContributions`/`subscribeSlot` exercise the
 * real `SlotRegistry`), with only `runExporter` replaced by a recorder
 * that resolves when the test says so — that keeps the busy state
 * observable mid-flight.
 */
class StubExtensionHost extends ExtensionHostService {
  readonly exporterRuns: Array<{ exporterId: string; extensionId: string }> = [];
  private readonly pendingResolves: Array<(output: ExporterOutput) => void> = [];

  constructor() {
    super({
      sdk: createBimContext({
        transport: {
          send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
          subscribe: () => () => {},
          close: () => {},
        },
      }),
    });
  }

  override runExporter(exporterId: string, extensionId: string): Promise<ExporterOutput> {
    this.exporterRuns.push({ exporterId, extensionId });
    return new Promise<ExporterOutput>((resolve) => {
      this.pendingResolves.push(resolve);
    });
  }

  resolvePendingRun(contribution: ExporterContribution, data: string | Uint8Array): void {
    const resolve = this.pendingResolves.shift();
    if (!resolve) throw new Error('no pending exporter run to resolve');
    const result: RuntimeRunResult = { value: undefined, logs: [], durationMs: 1 };
    resolve({ contribution, data, result });
  }
}

// ─── Fixtures & render plumbing ──────────────────────────────────────────

const EXPORTER_ID = 'ext.demo.export-csv';

function exporterContribution(overrides: Partial<ExporterContribution> = {}): ExporterContribution {
  return {
    id: EXPORTER_ID,
    name: 'Demo CSV',
    mimeType: 'text/csv',
    extension: 'csv',
    handler: 'exporters/csv.js',
    ...overrides,
  };
}

function registerExporter(
  host: ExtensionHostService,
  extensionId: string,
  payload: ExporterContribution,
): void {
  host.slotRegistry.register(extensionId, [{ extensionId, slot: 'exportMenu', payload }]);
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderExportSlot(host: ExtensionHostService): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ExtensionHostContext.Provider value={host}>
        <ExtensionExportSlot baseName="model" />
      </ExtensionHostContext.Provider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function buttonsIn(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')];
}

describe('ExtensionExportSlot rendering (#1907)', () => {
  beforeEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    anchorClicks.length = 0;
    createdBlobs.length = 0;
    downloadedKinds.length = 0;
  });

  it('renders nothing while the exportMenu slot is empty', () => {
    const container = renderExportSlot(new StubExtensionHost());
    assert.equal(container.innerHTML, '');
  });

  it('a registered exporter contribution APPEARS as a button labelled with its name', () => {
    const host = new StubExtensionHost();
    registerExporter(host, 'ext.alpha', exporterContribution());
    const container = renderExportSlot(host);

    const buttons = buttonsIn(container);
    assert.equal(buttons.length, 1, 'expected exactly one exporter button');
    assert.ok(
      buttons[0].textContent?.includes('Demo CSV'),
      `button must carry the exporter's name; got: ${JSON.stringify(buttons[0].textContent)}`,
    );
    assert.ok(buttons[0].textContent?.includes('.csv'), 'button shows the normalised extension');
    assert.ok(container.textContent?.includes('From extensions'), 'section label renders');
  });

  it('appears when a contribution is registered AFTER mount (subscription path)', () => {
    const host = new StubExtensionHost();
    const container = renderExportSlot(host);
    assert.equal(buttonsIn(container).length, 0);

    act(() => {
      registerExporter(host, 'ext.alpha', exporterContribution());
    });
    const buttons = buttonsIn(container);
    assert.equal(buttons.length, 1);
    assert.ok(buttons[0].textContent?.includes('Demo CSV'));
  });

  it('clicking runs the exporter with id AND owner, then downloads the produced bytes', async () => {
    const host = new StubExtensionHost();
    const payload = exporterContribution();
    registerExporter(host, 'ext.alpha', payload);
    const container = renderExportSlot(host);
    const [button] = buttonsIn(container);
    assert.ok(button, 'exporter button must render before it can be clicked');

    await act(async () => {
      button.click();
    });
    // Argument ORDER is part of the contract: (exporterId, extensionId).
    // Recording named fields from the real parameters pins both values.
    assert.deepEqual(host.exporterRuns, [{ exporterId: EXPORTER_ID, extensionId: 'ext.alpha' }]);

    const bytes = new TextEncoder().encode('a,b\n1,2\n');
    await act(async () => {
      host.resolvePendingRun(payload, bytes);
    });

    assert.equal(anchorClicks.length, 1, 'exactly one download anchor click');
    assert.equal(anchorClicks[0].download, 'model.csv', 'baseName + exporter extension');
    assert.equal(createdBlobs.length, 1);
    assert.equal(anchorClicks[0].href, 'blob:ifc-lite-test-1', 'anchor points at the produced blob');
    assert.equal(createdBlobs[0].type, 'text/csv', 'blob carries the contribution mime type');
    assert.deepEqual(
      new Uint8Array(await createdBlobs[0].arrayBuffer()),
      bytes,
      'the exporter bytes reach the download path unmodified',
    );
    assert.deepEqual(downloadedKinds, ['csv'], 'tour event fires from the download choke point');
  });

  it('same exporter id in two extensions: second button runs the SECOND extension and is the only busy one (#1930)', async () => {
    const host = new StubExtensionHost();
    const alphaPayload = exporterContribution({ name: 'Alpha CSV' });
    const betaPayload = exporterContribution({ name: 'Beta CSV' }); // same `id` on purpose
    registerExporter(host, 'ext.alpha', alphaPayload);
    registerExporter(host, 'ext.beta', betaPayload);
    const container = renderExportSlot(host);

    const buttons = buttonsIn(container);
    assert.equal(buttons.length, 2, 'one button PER contribution, not per exporter id');
    const alphaButton = buttons.find((b) => b.textContent?.includes('Alpha CSV'));
    const betaButton = buttons.find((b) => b.textContent?.includes('Beta CSV'));
    assert.ok(alphaButton && betaButton, 'both extensions render their own button');

    await act(async () => {
      betaButton.click();
    });
    // The confused-deputy fix: the run must carry ext.beta, not fall back
    // to the first extension that declares the id.
    assert.deepEqual(host.exporterRuns, [{ exporterId: EXPORTER_ID, extensionId: 'ext.beta' }]);

    // Busy state is keyed on owner:exporter — only beta's button spins,
    // while BOTH are disabled for the duration of the run. Compare booleans,
    // not elements: feeding a happy-dom node (with its React fiber graph) to
    // a failing assert.equal makes the error serializer OOM the process.
    const spinning = (button: HTMLButtonElement): boolean =>
      button.querySelector('.animate-spin') !== null;
    assert.equal(spinning(betaButton), true, 'running button shows the spinner');
    assert.equal(spinning(alphaButton), false, 'idle button does not spin');
    assert.equal(betaButton.disabled, true);
    assert.equal(alphaButton.disabled, true);

    await act(async () => {
      host.resolvePendingRun(betaPayload, 'col\nvalue\n');
    });
    assert.equal(spinning(betaButton), false, 'spinner clears after the run');
    assert.equal(betaButton.disabled, false);
    assert.equal(anchorClicks.length, 1);
    assert.equal(anchorClicks[0].download, 'model.csv');
  });
});
