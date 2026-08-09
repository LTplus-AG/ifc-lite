/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PR #2091 review (maintainer finding #2): `JSON.stringify` returns
 * `undefined` — not a thrown error — for a top-level `undefined`, function,
 * or symbol. Before this fix `saveJson` only guarded the THROWING case
 * (`try { JSON.stringify(value) } catch`), so a caller passing one of these
 * values sailed past the try/catch with `payload === undefined`, then
 * `localStorage.setItem(key, undefined)` stringifies the second argument
 * itself and stores the literal 4-byte string `"undefined"` — `ok: true`
 * for a value that cannot round-trip. Same defect class this PR already
 * fixes one layer up (#2101): a failure reported as a success.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { saveJson } from './save-result.js';

function installStubStorage(): Map<string, string> {
  const data = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
  } as Storage;
  return data;
}

describe('saveJson — a value JSON.stringify cannot round-trip (PR #2091 review)', () => {
  let data: Map<string, string>;
  beforeEach(() => { data = installStubStorage(); });

  it('reports a serialize failure for a top-level undefined instead of storing the literal string "undefined"', () => {
    const result = saveJson('k', undefined, 'lens changes');
    assert.equal(result.ok, false, 'a value that cannot round-trip must not report success');
    assert.equal(!result.ok && result.reason, 'serialize', 'must reuse the existing serialize failure reason');
    assert.equal(data.has('k'), false, 'nothing should be written to storage for an unserializable value');
  });

  it('reports a serialize failure for a top-level function', () => {
    const result = saveJson('k', () => {}, 'lens changes');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'serialize');
    assert.equal(data.has('k'), false);
  });

  it('reports a serialize failure for a top-level symbol', () => {
    const result = saveJson('k', Symbol('x'), 'lens changes');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'serialize');
    assert.equal(data.has('k'), false);
  });

  it('still succeeds for an ordinary serializable value (no regression)', () => {
    const result = saveJson('k', { a: 1 }, 'lens changes');
    assert.equal(result.ok, true);
    assert.equal(data.get('k'), '{"a":1}');
  });
});

describe('saveJson — quota vs. unavailable DOMException discrimination', () => {
  beforeEach(() => { installStubStorage(); });

  it('reports "quota" for a genuine QuotaExceededError', () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      ...(globalThis as unknown as { localStorage: Storage }).localStorage,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
    } as Storage;
    const result = saveJson('k', { a: 1 }, 'lens changes');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'quota');
    assert.ok(!result.ok && result.message.includes('full'), 'quota message must say storage is full');
  });

  it('reports "unavailable", not "quota", for a SecurityError DOMException (e.g. Safari private mode)', () => {
    // Safari's private-mode `setItem` throws a `SecurityError` DOMException,
    // not a quota error. Misreporting this as "quota" tells the user their
    // storage is full and sends them deleting data that is not the problem
    // (`&&` -> `||` on the QUOTA_ERROR_NAMES check would misclassify this).
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      ...(globalThis as unknown as { localStorage: Storage }).localStorage,
      setItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); },
    } as Storage;
    const result = saveJson('k', { a: 1 }, 'lens changes');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'unavailable',
      'a non-quota DOMException must not be classified as quota');
    assert.ok(!result.ok && result.message.includes('unavailable'),
      'unavailable message must not claim storage is full');
  });

  it('reports "unavailable" for a quota-NAMED error that is not a DOMException', () => {
    // Pins the `err instanceof DOMException` half of the guard, which the
    // other fixtures cannot: they all agree with a name-only check, so
    // dropping the instanceof survives them (maintainer mutation on #2138).
    //
    // `name` is a plain writable string, so anything that re-wraps or
    // normalises a storage error can carry a quota-ish name without being a
    // DOMException — and classifying that as quota produces the same wrong
    // advice this file exists to prevent: "free up space" when space was
    // never the problem.
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      ...(globalThis as unknown as { localStorage: Storage }).localStorage,
      setItem: () => {
        const impostor = new Error('not a DOMException');
        impostor.name = 'QuotaExceededError';
        throw impostor;
      },
    } as Storage;
    const result = saveJson('k', { a: 1 }, 'lens changes');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'unavailable',
      'the name matches, the type does not — type must win');
  });

  it('reports "unavailable" for a non-DOMException error (e.g. a plain thrown Error)', () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      ...(globalThis as unknown as { localStorage: Storage }).localStorage,
      setItem: () => { throw new Error('blocked by extension'); },
    } as Storage;
    const result = saveJson('k', { a: 1 }, 'lens changes');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'unavailable');
  });
});
