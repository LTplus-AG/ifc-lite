/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnonymizedExportDialog` — clicking Export actually produces the
 * anonymized `.ifc` (#2934): a real download (`EVENT_FILE_DOWNLOADED`) with
 * the neutral default filename `anonymized.ifc` (never the model name), STEP
 * content that keeps the structural types but scrubs the original
 * name/GUIDs by default, and exactly that one file — the dialog never offers
 * a separate GUID-map download. "Keep names" flips the name/GUID scrub off.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';
import { AnonymizedExportDialog } from './AnonymizedExportDialog.js';
import { parseFixtureModel, FIXTURE_WALL_A, guid } from './anonymized-export-fixture.test-support.js';

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

/** The Anonymize/Keep switch for one anonymization row (Radix renders
 *  role="switch"); ON = anonymize (default), clicking once turns it to Keep. */
function anonymizeSwitch(rowLabel: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(`button[role="switch"][aria-label="Anonymize ${rowLabel}"]`);
  assert.ok(el, `no Anonymize switch for "${rowLabel}"`);
  return el;
}

/** React-compatible typing into a controlled input (same recipe as CustomBasemapEditor.test.tsx). */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

interface Download { filename: string; blob: Blob }

/**
 * Captures every download `run` triggers through `lib/export/download.ts`:
 * filename + the actual Blob content (via a `URL.createObjectURL` patch,
 * since happy-dom's Blob has no readable content otherwise), AND counts
 * `EVENT_FILE_DOWNLOADED` to prove the shared choke point actually fired —
 * `downloadFile` calls `a.remove()` BEFORE emitting that event, so the
 * anchor itself must be read at CLICK time (`HTMLAnchorElement.click`
 * patch), not from the event listener, where it is already gone.
 */
async function captureDownloads(run: () => Promise<void> | void): Promise<{ downloads: Download[]; eventCount: number }> {
  const downloads: Download[] = [];
  let eventCount = 0;
  const blobByUrl = new Map<string, Blob>();
  const originalCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (obj: Blob | MediaSource) => {
    const url = originalCreate(obj as Blob);
    if (obj instanceof Blob) blobByUrl.set(url, obj);
    return url;
  };
  const anchorProto = window.HTMLAnchorElement.prototype;
  const originalClick = anchorProto.click;
  anchorProto.click = function patchedClick(this: HTMLAnchorElement) {
    downloads.push({ filename: this.download, blob: blobByUrl.get(this.href) ?? new Blob([]) });
    return originalClick.call(this);
  };
  const listener = () => { eventCount++; };
  window.addEventListener(EVENT_FILE_DOWNLOADED, listener);
  try {
    await run();
  } finally {
    window.removeEventListener(EVENT_FILE_DOWNLOADED, listener);
    anchorProto.click = originalClick;
    URL.createObjectURL = originalCreate;
  }
  return { downloads, eventCount };
}

beforeEach(async () => {
  unmountAll();
  const store = await parseFixtureModel();
  useViewerStore.setState({
    models: new Map([['m1', federatedModel('m1', store)]]),
    selectedEntity: { modelId: 'm1', expressId: FIXTURE_WALL_A },
    selectedEntityIds: new Set([globalId(FIXTURE_WALL_A)]),
    anonymizedExportRequested: false,
    isolatedEntities: null,
    ghostExceptEntities: null,
    hiddenEntities: new Set(),
  });
});

describe('AnonymizedExportDialog — export', () => {
  it('exports an anonymized .ifc: real download, structural types kept, original identifiers scrubbed', async () => {
    render(<AnonymizedExportDialog />);
    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });

    const exportButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Export .ifc'));
    assert.ok(exportButton, 'no Export .ifc button');

    const { downloads, eventCount } = await captureDownloads(async () => {
      await act(async () => {
        exportButton.click();
        await Promise.resolve();
      });
    });
    assert.equal(eventCount, 1, 'the export must go through the shared download choke point exactly once');

    const ifcDownload = downloads.find((d) => d.filename.endsWith('.ifc'));
    assert.ok(ifcDownload, `expected an .ifc download; saw ${downloads.map((d) => d.filename).join(', ')}`);
    assert.equal(ifcDownload.filename, 'anonymized.ifc', 'default filename must be the neutral stem, never derived from the model name');

    const text = await ifcDownload.blob.text();
    assert.match(text, /IFCWALL/, 'the wall type must survive anonymization');
    assert.match(text, /IFCWINDOW/, 'the window (reached via the opening) must survive');
    assert.equal(text.includes('Wall A'), false, 'the original wall name must be scrubbed by default');
    assert.equal(text.includes(guid(FIXTURE_WALL_A)), false, 'the original GlobalId must be regenerated by default');
  });

  it('"Keep names" leaves the original name in the exported STEP', async () => {
    render(<AnonymizedExportDialog />);
    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });

    const namesSwitch = anonymizeSwitch('Names');
    assert.equal(namesSwitch.getAttribute('aria-checked'), 'true', 'anonymize is ON by default');
    click(namesSwitch); // -> Keep

    const exportButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Export .ifc'));
    assert.ok(exportButton);
    const { downloads } = await captureDownloads(async () => {
      await act(async () => {
        exportButton.click();
        await Promise.resolve();
      });
    });
    const ifcDownload = downloads.find((d) => d.filename.endsWith('.ifc'));
    assert.ok(ifcDownload);
    const text = await ifcDownload.blob.text();
    assert.ok(text.includes('Wall A'), '"Keep names" must leave the original name in the export');
  });

  it('the user-entered file name is used for the .ifc download', async () => {
    render(<AnonymizedExportDialog />);
    act(() => { useViewerStore.getState().setAnonymizedExportRequested(true); });

    const stemInput = document.body.querySelector<HTMLInputElement>('#anon-file-stem');
    assert.ok(stemInput, 'no file name input');
    assert.equal(stemInput.value, 'anonymized', 'the field must not be prefilled from the model name');
    typeInto(stemInput, 'repro case 12.ifc');

    const exportButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Export .ifc'));
    assert.ok(exportButton);
    const { downloads } = await captureDownloads(async () => {
      await act(async () => {
        exportButton.click();
        await Promise.resolve();
      });
    });
    const ifcDownload = downloads.find((d) => d.filename.endsWith('.ifc'));
    assert.ok(ifcDownload);
    assert.equal(ifcDownload.filename, 'repro case 12.ifc', 'stem used as typed (a typed extension is stripped once, then re-added)');
    assert.equal(downloads.length, 1, 'exactly one file: the GUID map is never offered from the dialog');
  });
});
