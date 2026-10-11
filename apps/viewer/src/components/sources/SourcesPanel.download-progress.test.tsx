/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-file download progress in the Sources browser (#6375), driven the way a
 * user drives it: browse a provider, tick two files, press Load. The
 * provider's `download` is held open so each row's state can be read while
 * the batch is still running:
 *  - the file downloading shows a ring whose `aria-valuenow` follows the
 *    provider's `onProgress`, and the file behind it reads "Queued";
 *  - an unknown total shows a spinner, not a ring that cannot fill;
 *  - a failed file reads "Download failed" and keeps the browser open;
 *  - a batch where every file arrived closes the browser.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import {
  PLUGIN_API_VERSION,
  type DownloadOptions,
  type FileSourceProvider,
  type SourceFile,
} from '@ifc-lite/plugin-api';
import { render, cleanup, click } from '@/test/render.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { SOURCE_DOWNLOAD_EVENT } from '@/services/sources/source-host';
import { SourcesPanel } from './SourcesPanel.js';
import { activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';

const TOWER: SourceFile = { id: 'file-1', name: 'Tower.ifc', containerId: 'area-1', currentRevisionId: 'rev-1', sizeBytes: 100 };
const PODIUM: SourceFile = { id: 'file-2', name: 'Podium.ifc', containerId: 'area-1', currentRevisionId: 'rev-1', sizeBytes: 50 };

interface PendingDownload {
  readonly fileId: string;
  readonly options: DownloadOptions | undefined;
  resolve(buffer: ArrayBuffer): void;
  reject(error: Error): void;
}

/** A provider whose downloads stay open until the test settles them. */
function heldProvider(): { provider: FileSourceProvider; pending: PendingDownload[] } {
  const pending: PendingDownload[] = [];
  const provider: FileSourceProvider = {
    manifest: {
      name: 'acme-files',
      title: 'Acme Document Store',
      api: PLUGIN_API_VERSION,
      auth: 'preferences',
      permissions: { network: ['files.acme.example'] },
      preferences: [],
      capabilities: {
        containerListing: 'direct-children',
        listFilesIsRecursive: false,
        revisionHistory: false,
        downloadHistoricalRevisions: false,
        changeDetection: false,
        search: false,
      },
      contributes: { fileSources: [] },
    },
    listProjects: async () => ({ items: [{ id: 'project-1', name: 'Tower Project' }] }),
    listContainers: async (_ctx, _projectId, parentId) =>
      parentId ? { items: [] } : { items: [{ id: 'area-1', name: 'Documents' }] },
    listFiles: async () => ({ items: [TOWER, PODIUM] }),
    download: (_ctx, ref, options) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        pending.push({ fileId: ref.fileId, options, resolve, reject });
      }),
  };
  return { provider, pending };
}

async function pump(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function byAria(label: string): Element {
  const element = document.body.querySelector(`[aria-label="${label}"]`);
  assert.ok(element, `nothing labelled "${label}" is on screen`);
  return element;
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  assert.ok(button, `no button reading "${text}"`);
  return button;
}

/** The `<li>` row of a listed file, ticked or not. */
function row(name: string): HTMLElement {
  const checkbox =
    document.body.querySelector(`[aria-label="Deselect ${name}"]`) ?? byAria(`Select ${name}`);
  const item = checkbox.closest('li');
  assert.ok(item, `no row for ${name}`);
  return item as HTMLElement;
}

/** Browse the provider down to its only file area's listing. */
async function openListing(): Promise<void> {
  await pump();
  click(byAria('Browse Acme Document Store'));
  await pump();
  click(buttonWithText('Tower Project'));
  await pump();
  click(buttonWithText('Documents'));
  await pump();
}

/** Back out of the browser to the provider list, one wizard step at a time. */
async function leaveBrowser(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    click(byAria('Back'));
    await pump();
  }
  assert.ok(byAria('Browse Acme Document Store'), 'back on the provider list');
}

/** Open the listing, tick both files, press Load. */
async function startBatch(): Promise<void> {
  await openListing();
  click(byAria('Select Tower.ifc'));
  click(byAria('Select Podium.ifc'));
  click(buttonWithText('Load 2 files as federated model'));
  await pump();
}

function progress(download: PendingDownload, received: number, total?: number): void {
  act(() => download.options?.onProgress?.(received, total));
}

async function settle(action: () => void): Promise<void> {
  act(action);
  await pump();
}

afterEach(cleanup);

describe('SourcesPanel per-file download progress (#6375)', () => {
  it('rings the downloading file at its reported percent and marks the next one queued', async () => {
    const { provider, pending } = heldProvider();
    render(
      <SourceHostProvider additionalProviders={[() => provider]}>
        <SourcesPanel onClose={() => {}} />
      </SourceHostProvider>,
    );
    await startBatch();

    assert.equal(pending.length, 1, 'files download one at a time');
    assert.equal(pending[0].fileId, TOWER.id);
    assert.equal(row('Podium.ifc').textContent?.includes('Queued'), true, 'the second file waits as queued');

    progress(pending[0], 40, 100);
    const ring = row('Tower.ifc').querySelector('[role="progressbar"]');
    assert.ok(ring, 'the downloading file shows a progress ring');
    assert.equal(ring.getAttribute('aria-valuenow'), '40');
    assert.equal(ring.getAttribute('aria-label'), 'Downloading Tower.ifc');
    assert.ok(row('Tower.ifc').textContent?.includes('40%'), 'the percentage is shown beside the ring');

    progress(pending[0], 90, 100);
    assert.equal(row('Tower.ifc').querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '90');

    // 99.5% is not done: the ring and its text both read 99, never a full ring beside "99%".
    progress(pending[0], 995, 1000);
    assert.equal(row('Tower.ifc').querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '99');
    assert.ok(row('Tower.ifc').textContent?.includes('99%'));

    await settle(() => pending[0].resolve(new ArrayBuffer(100)));
    assert.equal(row('Tower.ifc').querySelector('[role="progressbar"]'), null, 'a downloaded file drops its ring');
    assert.equal(pending.length, 2, 'the next file starts once the first is in');
    assert.equal(row('Podium.ifc').textContent?.includes('Queued'), false);

    // Unknown size: a spinner that names the file, never a ring.
    progress(pending[1], 10, undefined);
    assert.equal(row('Podium.ifc').querySelector('[role="progressbar"]'), null);
    assert.ok(row('Podium.ifc').textContent?.includes('Downloading Podium.ifc'), 'the spinner announces the download');
  });

  it('cancels a batch and ignores bytes that arrive after cancellation', async () => {
    const { provider, pending } = heldProvider();
    const dispatched: unknown[] = [];
    const onDispatch = (event: Event) => dispatched.push((event as CustomEvent).detail);
    window.addEventListener(SOURCE_DOWNLOAD_EVENT, onDispatch);
    try {
      render(<SourceHostProvider additionalProviders={[() => provider]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
      await startBatch();
      click(buttonWithText('Cancel download'));
      await pump();
      assert.equal(pending[0].options?.signal?.aborted, true);
      await settle(() => pending[0].resolve(new ArrayBuffer(100)));
      assert.equal(dispatched.length, 0, 'late bytes cannot enter the canonical loader');
      // #7134: the actual Sources panel settles its native cancellation in Activity.
      const job = useActivityJournal.getState().jobs.at(-1); assert.ok(job);
      assert.equal(job.outcome, 'cancelled');
      assert.equal(activityCanceller(job.id), null);
      assert.equal(pending.length, 1, 'queued file never starts');
      assert.equal(document.querySelector('[role="progressbar"]'), null);
      assert.equal(buttonWithText('Load 2 files as federated model').disabled, false);
    } finally { window.removeEventListener(SOURCE_DOWNLOAD_EVENT, onDispatch); }
  });

  it('keeps the browser open with the failed file marked when one download fails', async () => {
    const { provider, pending } = heldProvider();
    const dispatched: unknown[] = [];
    const onDispatch = (event: Event) => dispatched.push((event as CustomEvent).detail);
    window.addEventListener(SOURCE_DOWNLOAD_EVENT, onDispatch);
    try {
      render(
        <SourceHostProvider additionalProviders={[() => provider]}>
          <SourcesPanel onClose={() => {}} />
        </SourceHostProvider>,
      );
      await startBatch();
      await settle(() => pending[0].reject(new Error('upstream exploded')));
      await settle(() => pending[1].resolve(new ArrayBuffer(50)));

      assert.equal(dispatched.length, 1, 'only the file that arrived is loaded');
      assert.ok(row('Tower.ifc').textContent?.includes('Download failed'), 'the failed file says so');
      assert.equal(row('Podium.ifc').textContent?.includes('Download failed'), false);
    } finally {
      window.removeEventListener(SOURCE_DOWNLOAD_EVENT, onDispatch);
    }
  });

  it('closes the browser once every file in the batch has downloaded', async () => {
    const { provider, pending } = heldProvider();
    render(
      <SourceHostProvider additionalProviders={[() => provider]}>
        <SourcesPanel onClose={() => {}} />
      </SourceHostProvider>,
    );
    await startBatch();
    progress(pending[0], 100, 100);
    await settle(() => pending[0].resolve(new ArrayBuffer(100)));

    // Mid-batch: still open, so the second file's row is still there to watch.
    assert.ok(row('Podium.ifc'), 'the browser stays open while the batch runs');

    await settle(() => pending[1].resolve(new ArrayBuffer(50)));
    assert.equal(document.body.querySelector('[aria-label="Deselect Podium.ifc"]'), null, 'the browser closed');
    assert.ok(byAria('Browse Acme Document Store'), 'back on the provider list');
  });

  // Back does not cancel a running batch, so a browser reopened mid-batch
  // must show it as it is, while a finished batch's failures are forgotten.
  it('shows a still-running batch truthfully after Back, and forgets a finished one\'s failures', async () => {
    const { provider, pending } = heldProvider();
    render(
      <SourceHostProvider additionalProviders={[() => provider]}>
        <SourcesPanel onClose={() => {}} />
      </SourceHostProvider>,
    );
    await startBatch();
    progress(pending[0], 30, 100);

    await leaveBrowser();
    await openListing();
    assert.equal(row('Tower.ifc').querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '30');
    assert.ok(row('Podium.ifc').textContent?.includes('Queued'), 'the file still waiting reads queued');

    await settle(() => pending[0].reject(new Error('upstream exploded')));
    await settle(() => pending[1].resolve(new ArrayBuffer(50)));
    assert.ok(row('Tower.ifc').textContent?.includes('Download failed'));

    await leaveBrowser();
    await openListing();
    assert.equal(row('Tower.ifc').textContent?.includes('Download failed'), false, 'a closed batch leaves no failure behind');
  });
});
