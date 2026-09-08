/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PR #2091 review (maintainer finding #1): `LensPanel.handleImport` wired
 * `reader.onload` but never `reader.onerror`. A failed file read (removed
 * file, permissions error, any real I/O failure on the file the user
 * picked) produced neither an import nor a toast — the callback chain
 * simply never ran, so nothing happened and there was no signal why.
 *
 * happy-dom's `FileReader` (like real browsers) has no built-in way to
 * force a read failure, so these tests intercept the constructor with a
 * subclass whose `readAsText` fires `onerror` instead of `onload` — the
 * standard way to pin this path without real broken filesystem I/O.
 *
 * The assertion is the user-visible consequence, not "an onerror handler
 * exists": without the fix, `readFileAsText`'s promise never settles at
 * all (no `onload`, no `onerror`), so these tests race it against a
 * timeout and require it to REJECT within that window.
 */

import '@/test/setup-dom.js';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileAsText, importLensFile } from './lens-import.js';

/** Run `fn` with the global `FileReader` swapped for one whose `readAsText`
 *  always fails asynchronously (simulating a real read I/O error), then
 *  restore the original regardless of outcome. */
async function withFailingFileReader<T>(fn: () => Promise<T>): Promise<T> {
  const OriginalFileReader = globalThis.FileReader;
  class FailingFileReader extends OriginalFileReader {
    readAsText(): void {
      setTimeout(() => {
        this.onerror?.(new Event('error') as ProgressEvent<globalThis.FileReader>);
      }, 0);
    }
  }
  globalThis.FileReader = FailingFileReader as unknown as typeof FileReader;
  try {
    return await fn();
  } finally {
    globalThis.FileReader = OriginalFileReader;
  }
}

/**
 * Observe whether/how `promise` settles within `ms`. Deliberately NOT a
 * `Promise.race` against a timeout: racing a rejecting timeout in would make
 * `assert.rejects` pass vacuously even when `promise` never settles at all
 * (the actual bug) — the race's own timeout rejection satisfies "rejects"
 * regardless of what the promise under test did. Recording the outcome in a
 * variable instead distinguishes "settled: rejected" from "never settled"
 * as two different, distinguishable results.
 */
function observe<T>(promise: Promise<T>): { settled: () => 'pending' | 'resolved' | 'rejected' } {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  promise.then(
    () => { state = 'resolved'; },
    () => { state = 'rejected'; },
  );
  return { settled: () => state };
}

function jsonFile(name = 'lenses.json'): File {
  return new File(['{}'], name, { type: 'application/json' });
}

describe('readFileAsText — a failed read (PR #2091 review)', () => {
  it('rejects when the underlying read fails, instead of leaving the promise pending forever', async () => {
    const observed = observe(withFailingFileReader(() => readFileAsText(jsonFile())));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      observed.settled(),
      'rejected',
      'a failed read must reject the promise, not leave it pending forever',
    );
  });
});

describe('importLensFile — a failed read (PR #2091 review)', () => {
  it('resolves to a reportable failure instead of hanging or importing garbage', async () => {
    const importLenses = mock.fn(() => ({ ok: true as const }));
    const outcomeRef: { current: Awaited<ReturnType<typeof importLensFile>> | null } = { current: null };
    withFailingFileReader(() => importLensFile(jsonFile(), importLenses)).then((o) => { outcomeRef.current = o; });
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(outcomeRef.current, 'importLensFile must settle instead of hanging on a failed read');
    assert.equal(outcomeRef.current?.ok, false, 'a file that could not be read must not report success');
    assert.equal(
      importLenses.mock.callCount(),
      0,
      'a read that produced no text must never reach the store importer',
    );
  });
});
