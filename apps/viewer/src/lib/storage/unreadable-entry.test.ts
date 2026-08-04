/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  preserveUnreadableEntry,
  forgetEntryAndBackups,
  type UnreadableEntryStorage,
} from './unreadable-entry.js';

/** In-memory storage; `failSetKeys` makes specific writes throw. */
function stubStorage(failSetKeys: readonly string[] = []): UnreadableEntryStorage & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    // `length`/`key()` are part of the real Storage interface, and
    // `forgetEntryAndBackups` uses them to find counter-suffixed copies. A stub
    // without them silently skips that branch, so the double has to carry them
    // or the wipe test passes for the wrong reason.
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      if (failSetKeys.includes(k)) throw new DOMException('quota', 'QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe('preserveUnreadableEntry', () => {
  it('never clobbers an earlier preserved copy, even within one millisecond', () => {
    // The guard used to suffix with `Date.now()`, so two quarantines of the same
    // key inside a single millisecond picked the same backup name and the second
    // overwrote the first — the exact thing the guard exists to prevent. A
    // counter cannot collide regardless of clock resolution, and this test runs
    // all three quarantines synchronously, which is what `Date.now()` could not
    // survive (maintainer finding on #2089).
    const st = stubStorage();

    st.map.set('K', 'first');
    assert.strictEqual(preserveUnreadableEntry(st, 'K', new Error('x')), true);

    st.map.set('K', 'second');
    assert.strictEqual(preserveUnreadableEntry(st, 'K', new Error('x')), true);

    st.map.set('K', 'third');
    assert.strictEqual(preserveUnreadableEntry(st, 'K', new Error('x')), true);

    // Every payload survives under a distinct key, and the live key is cleared.
    const preserved = [...st.map.entries()]
      .filter(([k]) => k !== 'K')
      .map(([, v]) => v)
      .sort();
    assert.deepStrictEqual(preserved, ['first', 'second', 'third']);
    assert.strictEqual(st.map.get('K'), undefined);
  });

  it('reports failure when the backup itself cannot be written, and leaves the value alone', () => {
    // The caller uses this to refuse a later overwrite: a blocked quarantine
    // must not also destroy the original.
    const st = stubStorage(['K:unreadable']);
    st.map.set('K', 'precious');

    assert.strictEqual(preserveUnreadableEntry(st, 'K', new Error('x')), false);
    assert.strictEqual(st.map.get('K'), 'precious');
  });

  it('forgetEntryAndBackups removes the entry and every preserved copy', () => {
    const st = stubStorage();
    st.map.set('K', 'a');
    preserveUnreadableEntry(st, 'K', new Error('x'));
    st.map.set('K', 'b');
    preserveUnreadableEntry(st, 'K', new Error('x'));

    forgetEntryAndBackups(st, 'K');
    assert.deepStrictEqual([...st.map.keys()], []);
  });
});
