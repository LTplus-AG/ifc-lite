/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rendering tests for the CloudImportDialog review fixes:
 *
 *  - `onPick` is awaited: a rejecting `onPick` must not report "Loaded" —
 *    it should surface an error toast, keep the dialog open, and leave no
 *    stuck spinner (Greptile: success reported before ingestion happens).
 *  - `goUp` computes the next trail outside the `setTrail` updater, so it
 *    calls `load()` (which — for the real Google provider — opens the
 *    Picker) exactly once per click, not once per updater invocation.
 *  - `load()` carries a request-sequence guard so a stale (out-of-order)
 *    `listFolder` response can't clobber a newer one.
 *  - `handleDisconnect` clears local state before awaiting
 *    `provider.disconnect()`, so a rejection there doesn't leave the
 *    dialog stuck "connected".
 *
 * Uses `@/test/setup-dom.js` + React 19 `createRoot`/`act`, following the
 * pattern established in `ExtensionExportSlot.test.tsx`. Every provider
 * method that matters to a given test is *deferred* (an explicit resolve/
 * reject captured by the test) rather than left to resolve on its own
 * timing — real-clock waits proved unreliable for driving `act()` in this
 * harness, deferred promises resolved by hand did not.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from '@/components/ui/toast';
import { CloudNotConnectedError } from '@/services/cloud/types';
import type { CloudFileEntry, CloudProvider } from '@/services/cloud/types';
import { CloudImportDialog } from './CloudImportDialog.js';

const originalToastSuccess = toast.success;
const originalToastError = toast.error;
let successToasts: string[] = [];
let errorToasts: string[] = [];

function entry(overrides: Partial<CloudFileEntry> = {}): CloudFileEntry {
  return { id: 'f1', name: 'Tower.ifc', path: 'f1', size: 1024, isFolder: false, modifiedMs: null, ...overrides };
}

/** A promise plus its resolve/reject, for hand-driving a provider call. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (err: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeProvider(overrides: Partial<CloudProvider> = {}): CloudProvider {
  return {
    id: 'test',
    label: 'Test Provider',
    isConnected: () => true,
    connect: async () => {},
    disconnect: async () => {},
    listFolder: async () => [entry()],
    download: async () => new File(['x'], 'Tower.ifc'),
    ...overrides,
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

async function renderAndFlush(props: {
  open: boolean;
  onClose: () => void;
  provider: CloudProvider;
  onPick: (file: File) => Promise<void>;
}): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<CloudImportDialog {...props} />);
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function fileButtons(): HTMLButtonElement[] {
  // Radix `Dialog` portals its content directly under `document.body`, not
  // into the `container` div `root.render()` was called on — query the body.
  return [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.includes('.ifc'));
}

const originalConsoleWarn = console.warn;

describe('CloudImportDialog', () => {
  beforeEach(() => {
    successToasts = [];
    errorToasts = [];
    toast.success = (message: string) => { successToasts.push(message); };
    toast.error = (message: string) => { errorToasts.push(message); };
    // The disconnect-rejection test deliberately triggers one expected
    // `console.warn` (the handler logs before surfacing the toast) — silence
    // it so test output stays focused on real failures.
    console.warn = () => {};
  });

  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => { root.unmount(); });
      container.remove();
    }
    toast.success = originalToastSuccess;
    toast.error = originalToastError;
    console.warn = originalConsoleWarn;
  });

  it('reports success only after onPick resolves, and closes', async () => {
    const pick = deferred<void>();
    let closed = false;
    await renderAndFlush({
      open: true,
      onClose: () => { closed = true; },
      provider: makeProvider(),
      onPick: () => pick.promise,
    });
    await flush();

    const [button] = fileButtons();
    assert.ok(button, 'expected the picked file to render as a row');
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });

    // Download resolved, but onPick (the loader) has NOT resolved yet.
    assert.deepEqual(successToasts, [], 'must not report success before onPick settles');
    assert.equal(closed, false, 'must not close before onPick settles');

    await act(async () => { pick.resolve(); await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(successToasts, ['Loaded Tower.ifc from Test Provider']);
    assert.equal(closed, true);
  });

  it('a rejecting onPick produces an error toast, not a success toast, and does not close', async () => {
    const pick = deferred<void>();
    let closed = false;
    await renderAndFlush({
      open: true,
      onClose: () => { closed = true; },
      provider: makeProvider(),
      onPick: () => pick.promise,
    });
    await flush();

    const [button] = fileButtons();
    assert.ok(button);
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      pick.reject(new Error('IFC parsing failed: bad header'));
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.deepEqual(successToasts, [], 'a failed ingest must never report success');
    assert.equal(errorToasts.length, 1);
    assert.match(errorToasts[0], /IFC parsing failed/);
    assert.equal(closed, false, 'the dialog must stay open on failure');
    // No stuck spinner: the button must be re-enabled (not perpetually "downloading").
    assert.equal(button.disabled, false);
  });

  it('goUp calls load() exactly once (not per setTrail updater invocation)', async () => {
    let listCalls = 0;
    const provider = makeProvider({
      listFolder: async (path: string) => {
        listCalls++;
        if (path === '') return [entry({ id: 'sub', name: 'Sub', isFolder: true, path: 'sub' })];
        return [entry()];
      },
    });

    // StrictMode is what actually exercises the bug this test guards: React
    // double-invokes a `setTrail` updater function in StrictMode dev builds,
    // so `load()` nested inside that updater (the bug) fires twice per
    // click. Without StrictMode the updater only runs once either way and
    // this test can't tell the fixed code from the broken code.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
      root.render(
        <StrictMode>
          <CloudImportDialog open={true} onClose={() => {}} provider={provider} onPick={async () => {}} />
        </StrictMode>,
      );
    });
    await flush();
    // StrictMode double-invokes the mount effect (standard React 18/19 dev
    // behavior, unrelated to the bug this test targets), so the root load
    // itself already accounts for 2 calls here — that's a StrictMode
    // baseline, not something this test is asserting about.
    const afterMount = listCalls;
    assert.equal(afterMount, 2, 'StrictMode dev baseline: the mount effect double-fires');

    const folderButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Sub'));
    assert.ok(folderButton);
    await act(async () => { folderButton.click(); await Promise.resolve(); await Promise.resolve(); });
    const afterEnter = listCalls;
    assert.equal(afterEnter, afterMount + 1, 'entering a folder triggers exactly one listFolder call (event handlers are not double-invoked by StrictMode)');

    const upButton = document.body.querySelector('button[title="Up one folder"]') as HTMLButtonElement;
    assert.ok(upButton);
    await act(async () => { upButton.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(
      listCalls,
      afterEnter + 1,
      'goUp must trigger exactly one MORE listFolder call — the bug (load() nested inside the setTrail updater) ' +
      'would make StrictMode invoke that updater twice, adding two calls instead of one',
    );
  });

  it('an out-of-order (stale) listFolder response does not clobber the newer one', async () => {
    // Folder rows are not gated by `listing` (only the Up/Refresh buttons
    // are), so — as in a real browser, where React 18/19 batches the DOM
    // update from the first click's state change rather than committing it
    // synchronously — two folder rows in an already-rendered list can both
    // be clicked before either click's `load()` call resolves. Folder A's
    // response arrives LATE (after B's); it must not clobber B's.
    const folderA = deferred<CloudFileEntry[]>();
    const provider = makeProvider({
      listFolder: async (path: string) => {
        if (path === '') {
          return [
            entry({ id: 'a', name: 'FolderA', isFolder: true, path: 'a' }),
            entry({ id: 'b', name: 'FolderB', isFolder: true, path: 'b' }),
          ];
        }
        if (path === 'a') return folderA.promise; // stays pending until the test resolves it
        if (path === 'b') return [entry({ id: 'in-b', name: 'InFolderB.ifc' })];
        throw new Error(`unexpected path: ${path}`);
      },
    });

    await renderAndFlush({ open: true, onClose: () => {}, provider, onPick: async () => {} });
    await flush(); // root loaded: FolderA and FolderB rows now rendered

    const rowFor = (name: string) =>
      [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(name)) as HTMLButtonElement;

    // Click A, then (same batch, before A's state update commits) click B.
    await act(async () => {
      rowFor('FolderA').click();
      rowFor('FolderB').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.ok(document.body.textContent?.includes('InFolderB.ifc'), 'the newer (B) request must have populated entries');

    // A's stale response finally arrives.
    await act(async () => {
      folderA.resolve([entry({ id: 'in-a', name: 'InFolderA.ifc' })]);
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.ok(
      document.body.textContent?.includes('InFolderB.ifc'),
      'the stale (A) response must not have overwritten the newer (B) entries',
    );
    assert.ok(!document.body.textContent?.includes('InFolderA.ifc'), 'the stale response must have been discarded');
  });

  it('handleDisconnect clears local connected state even if provider.disconnect() rejects', async () => {
    const provider = makeProvider({
      disconnect: async () => { throw new Error('revoke failed'); },
    });

    await renderAndFlush({ open: true, onClose: () => {}, provider, onPick: async () => {} });
    await flush();

    const disconnectButton = document.body.querySelector('button[title="Disconnect"]') as HTMLButtonElement;
    assert.ok(disconnectButton);
    await act(async () => { disconnectButton.click(); await Promise.resolve(); await Promise.resolve(); });

    assert.ok(
      document.body.textContent?.includes(`Connect ${provider.label}`),
      'disconnect must clear local state even when the request itself failed',
    );
    assert.equal(errorToasts.length, 1, 'the failure must still be surfaced, not silently swallowed');
  });

  it('a CloudNotConnectedError from download resets to the disconnected view without a toast', async () => {
    const provider = makeProvider({
      download: async () => { throw new CloudNotConnectedError('test'); },
    });
    await renderAndFlush({ open: true, onClose: () => {}, provider, onPick: async () => {} });
    await flush();

    const [button] = fileButtons();
    assert.ok(button);
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });

    assert.ok(document.body.textContent?.includes(`Connect ${provider.label}`));
    assert.deepEqual(errorToasts, []);
    assert.deepEqual(successToasts, []);
  });
});
