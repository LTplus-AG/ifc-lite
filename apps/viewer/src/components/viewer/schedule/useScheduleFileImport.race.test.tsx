/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rendering test for the stale-confirmation race in `useScheduleFileImport`
 * (PR #1963 review). `pendingImport` — the state backing the destructive
 * clobber-confirm banner — used to be cleared only on confirm or cancel,
 * never when a NEW file selection started. `importSeqRef` guards the async
 * FileReader result against landing late, but did nothing about the banner
 * itself:
 *
 *   1. Pick file A. The clobber-confirm banner appears, holding A's parsed
 *      result.
 *   2. Pick file B before answering it. `handleImportFileChange` bumps the
 *      seq token and starts reading B — but the banner still shows A's
 *      stale result at this exact instant, because nothing cleared it.
 *   3. If the user confirms in that window, the stale A is applied and
 *      committed to the store, discarding whatever B was about to become.
 *
 * The fix clears `pendingImport` synchronously at the top of
 * `handleImportFileChange`, before the new file's async read even starts.
 * That closes the window in step 2/3 above entirely — confirming with no
 * `pendingImport` is a no-op — rather than relying on the read eventually
 * resolving to the right file.
 *
 * This is a real DOM rendering test (matches `ExtensionExportSlot.test.tsx`)
 * rather than calling the hook's internals directly, because the race lives
 * in the interaction between a real `<input type="file">` change event, the
 * hook's internal state, and the store it commits into — there is nothing
 * pure to pull out and test in isolation the way the sibling
 * `useScheduleFileImport.test.ts` pins the decision helpers.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { useScheduleFileImport, type PendingScheduleImport } from './useScheduleFileImport.js';

// Any schedule with an `expressId > 0` task forces `shouldConfirmClobber`
// to true regardless of which file is picked, so every selection in this
// test stages a confirmation rather than applying immediately.
const CLOBBER_SCHEDULE_DATA = { tasks: [{ expressId: 42 }] };

function csvFile(name: string, taskName: string): File {
  return new File([`name\n${taskName}\n`], name, { type: 'text/csv' });
}

/**
 * Poll until `predicate()` is true or `timeoutMs` elapses, then assert it
 * held. Deliberately NOT wrapped in `act()`: React's async `act()` defers
 * flushing renders until its own callback settles, which would hide every
 * intermediate update from `predicate()` and make this loop spin until the
 * timeout even though the state changed. `FileReader#onload` firing outside
 * of `act()` (a real async DOM callback the test isn't driving directly)
 * produces a harmless act() console warning, which is the accepted
 * tradeoff — the alternative is a test that cannot observe the very state
 * transition it exists to pin.
 */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`timed out waiting for: ${message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

interface HookSnapshot {
  pendingImport: PendingScheduleImport | null;
  confirmPendingImport: () => void;
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderHarness(): { input: HTMLInputElement; latest: () => HookSnapshot } {
  let snapshot: HookSnapshot | null = null;

  function Harness() {
    const { importFileInputRef, pendingImport, handleImportFileChange, confirmPendingImport } =
      useScheduleFileImport(new Map(), null);
    snapshot = { pendingImport, confirmPendingImport };
    return (
      <input
        ref={importFileInputRef}
        type="file"
        data-testid="schedule-import-input"
        onChange={e => handleImportFileChange(e, CLOBBER_SCHEDULE_DATA, false)}
      />
    );
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Harness />);
  });
  mounted.push({ root, container });

  const input = container.querySelector('input[type="file"]');
  assert.ok(input instanceof HTMLInputElement, 'file input must render');
  return {
    input,
    latest: () => {
      assert.ok(snapshot, 'hook must have rendered at least once');
      return snapshot;
    },
  };
}

/** Simulate picking `file` in the rendered `<input type="file">`. */
function pickFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('useScheduleFileImport — stale confirmation race (PR #1963)', () => {
  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    // Reset the store so a committed schedule doesn't leak into other tests.
    useViewerStore.setState({ scheduleData: null, dirtyModels: new Set() });
  });

  it('a new selection retires the stale banner immediately, before the new file has even been read', async () => {
    const { input, latest } = renderHarness();

    pickFile(input, csvFile('a.csv', 'Task A'));
    await waitFor(() => latest().pendingImport?.fileName === 'a.csv', 'banner shows file A');
    assert.equal(latest().pendingImport?.result.taskCount, 1);

    // Pick file B. Synchronously, right after this dispatch — before B's
    // FileReader has had any chance to complete — the banner must already
    // be gone. This is the exact window the bug lived in: `importSeqRef`
    // only protects the READ from landing late, it does nothing about the
    // banner still showing A.
    pickFile(input, csvFile('b.csv', 'Task B'));
    assert.equal(
      latest().pendingImport,
      null,
      'pendingImport must be cleared synchronously by the new selection, not left holding file A',
    );

    // Confirming in this exact window — before B has been read — must be a
    // safe no-op, not a stale apply of A. Without the fix this would call
    // applyScheduleImport with A's result and commit it to the store.
    act(() => {
      latest().confirmPendingImport();
    });
    assert.equal(
      useViewerStore.getState().scheduleData,
      null,
      'confirming with no pendingImport must not commit anything — in particular, never A',
    );

    // Now let B's read finish for real and confirm again — B, and only B,
    // must be what ends up applied.
    await waitFor(() => latest().pendingImport?.fileName === 'b.csv', 'banner now shows file B');
    act(() => {
      latest().confirmPendingImport();
    });

    const committed = useViewerStore.getState().scheduleData;
    assert.ok(committed, 'confirming with file B pending must commit a schedule');
    assert.deepEqual(
      committed.tasks.map(t => t.name),
      ['Task B'],
      'the committed schedule must be file B — file A must never reach the store',
    );
  });
});
