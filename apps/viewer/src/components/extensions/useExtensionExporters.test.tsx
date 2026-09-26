/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Extension exporters are export-registry entries (#5838), rendered by every
 * export surface — the "appears" half of #1907, which used to be proven for a
 * block inside the IFC dialog only.
 *
 * The host injected through `ExtensionHostContext` is a real
 * `ExtensionHostService` subclass over a real `SlotRegistry` — only
 * `runExporter` is overridden (the genuine one needs a QuickJS sandbox and
 * IndexedDB). Download assertions sit on the browser seams the code
 * actually uses: the bubbling click of the `<a download>` anchor that
 * `downloadFile` dispatches, the `Blob` handed to `URL.createObjectURL`,
 * and the `ifc-lite:file-downloaded` tour event.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExporterContribution, RuntimeRunResult } from '@ifc-lite/extensions';
import { createBimContext } from '@ifc-lite/sdk';
import { ExtensionHostService } from '@/services/extensions/host.js';
import type { ExporterOutput } from '@/services/extensions/host-exporters.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { EXPORT_COMMAND_IDS, type ExportIconSet } from '@/components/viewer/toolbar/export-commands';
import { ClassicExportMenuItems } from '@/components/viewer/toolbar/ClassicExportMenuItems';
import { RibbonExportGroup } from '@/components/viewer/ribbon/tabs/RibbonExportGroup';
import { buildExportCommands } from '@/components/viewer/commandPaletteExports';
import { usePaletteExportRunner } from '@/components/viewer/usePaletteExportRunner';

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

function mount(host: ExtensionHostService, node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ExtensionHostContext.Provider value={host}>
        <TooltipProvider>{node}</TooltipProvider>
      </ExtensionHostContext.Provider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function StubIcon(props: React.SVGProps<SVGSVGElement>) {
  return <svg {...props} />;
}
const STUB_ICONS = Object.fromEntries(
  [...EXPORT_COMMAND_IDS, 'extension'].map((id) => [id, StubIcon]),
) as ExportIconSet;

/** The ribbon's File > Export group. */
function renderRibbon(host: ExtensionHostService): HTMLElement {
  return mount(host, <RibbonExportGroup icons={STUB_ICONS} />);
}

/** Every extension exporter control on screen, in DOM order. */
function extensionControls(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[data-export-extension]')];
}

let paletteRunner: ReturnType<typeof usePaletteExportRunner> | null = null;
function PaletteRunnerHarness() {
  paletteRunner = usePaletteExportRunner();
  return null;
}

describe('extension exporters are export-registry entries (#1907, #5838)', () => {
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
    paletteRunner = null;
    const model = fixtureModel('m');
    model.name = 'Haus.ifc';
    useViewerStore.setState({ ...fixtureModels(model) });
  });

  it('renders no extension row while the exportMenu slot is empty', () => {
    renderRibbon(new StubExtensionHost());
    assert.equal(extensionControls().length, 0);
  });

  it('a registered exporter APPEARS in the ribbon, the classic menu and the palette, labelled with its name', () => {
    const host = new StubExtensionHost();
    registerExporter(host, 'ext.alpha', exporterContribution());

    renderRibbon(host);
    mount(host, (
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Export</DropdownMenuTrigger>
        <DropdownMenuContent><ClassicExportMenuItems /></DropdownMenuContent>
      </DropdownMenu>
    ));
    const controls = extensionControls();
    assert.deepEqual(controls.map((c) => c.getAttribute('data-export-extension')), [`ext.alpha:${EXPORTER_ID}`, `ext.alpha:${EXPORTER_ID}`]);
    for (const control of controls) {
      assert.ok(control.textContent?.includes('Demo CSV'), `row carries the exporter's name: ${JSON.stringify(control.textContent)}`);
    }
    assert.ok(document.body.textContent?.includes('From extensions'), 'the classic menu labels the group');

    mount(host, <PaletteRunnerHarness />);
    assert.ok(paletteRunner);
    const rows = buildExportCommands(() => {}, paletteRunner.extensionExporters).filter((c) => c.id.startsWith('export:ext:'));
    assert.deepEqual(rows.map((r) => [r.id, r.label, r.detail]), [[`export:ext:ext.alpha:${EXPORTER_ID}`, 'Demo CSV', '.csv']]);
  });

  it('appears when a contribution is registered AFTER mount (subscription path)', () => {
    const host = new StubExtensionHost();
    renderRibbon(host);
    assert.equal(extensionControls().length, 0);

    act(() => {
      registerExporter(host, 'ext.alpha', exporterContribution());
    });
    const controls = extensionControls();
    assert.equal(controls.length, 1);
    assert.ok(controls[0].textContent?.includes('Demo CSV'));
  });

  it('clicking runs the exporter with id AND owner, then downloads the bytes under the active model name', async () => {
    const host = new StubExtensionHost();
    const payload = exporterContribution();
    registerExporter(host, 'ext.alpha', payload);
    renderRibbon(host);
    const [button] = extensionControls();
    assert.ok(button, 'exporter button must render before it can be clicked');

    await act(async () => {
      button.click();
    });
    // Argument ORDER is part of the contract: (exporterId, extensionId).
    assert.deepEqual(host.exporterRuns, [{ exporterId: EXPORTER_ID, extensionId: 'ext.alpha' }]);

    const bytes = new TextEncoder().encode('a,b\n1,2\n');
    await act(async () => {
      host.resolvePendingRun(payload, bytes);
    });

    assert.equal(anchorClicks.length, 1, 'exactly one download anchor click');
    assert.equal(anchorClicks[0].download, 'Haus.csv', 'model name + exporter extension (#5833)');
    assert.equal(createdBlobs.length, 1);
    assert.equal(anchorClicks[0].href, 'blob:ifc-lite-test-1', 'anchor points at the produced blob');
    assert.equal(createdBlobs[0].type, 'text/csv', 'blob carries the contribution mime type');
    assert.deepEqual(new Uint8Array(await createdBlobs[0].arrayBuffer()), bytes, 'the exporter bytes reach the download unmodified');
    assert.deepEqual(downloadedKinds, ['csv'], 'tour event fires from the download choke point');
  });

  it('the palette row runs the same exporter through the same path', async () => {
    const host = new StubExtensionHost();
    const payload = exporterContribution();
    registerExporter(host, 'ext.alpha', payload);
    mount(host, <PaletteRunnerHarness />);
    assert.ok(paletteRunner);
    const [row] = buildExportCommands(paletteRunner.runExport, paletteRunner.extensionExporters).filter((c) => c.id.startsWith('export:ext:'));
    assert.ok(row);
    await act(async () => {
      row.action();
    });
    assert.deepEqual(host.exporterRuns, [{ exporterId: EXPORTER_ID, extensionId: 'ext.alpha' }]);
    await act(async () => {
      host.resolvePendingRun(payload, 'x');
    });
    assert.equal(anchorClicks[0]?.download, 'Haus.csv');
  });

  it('same exporter id in two extensions: second button runs the SECOND extension and is the only busy one (#1930)', async () => {
    const host = new StubExtensionHost();
    const alphaPayload = exporterContribution({ name: 'Alpha CSV' });
    const betaPayload = exporterContribution({ name: 'Beta CSV' }); // same `id` on purpose
    registerExporter(host, 'ext.alpha', alphaPayload);
    registerExporter(host, 'ext.beta', betaPayload);
    renderRibbon(host);

    const buttons = extensionControls() as HTMLButtonElement[];
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
    // One run at a time: both rows are disabled while it is in flight.
    assert.equal(betaButton.disabled, true);
    assert.equal(alphaButton.disabled, true);

    await act(async () => {
      host.resolvePendingRun(betaPayload, 'col\nvalue\n');
    });
    assert.equal(betaButton.disabled, false);
    assert.equal(anchorClicks.length, 1);
    assert.equal(anchorClicks[0].download, 'Haus.csv');
  });
});
