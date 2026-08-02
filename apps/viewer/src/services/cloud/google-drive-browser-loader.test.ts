/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Covers the fix for a real bug: a transient script-load failure (ad
 * blocker, network blip, `accounts.google.com` temporarily unreachable)
 * used to cache the *rejected* promise forever, so every subsequent retry —
 * for the rest of the page session — got that same stale rejection
 * instantly instead of actually trying again.
 *
 * happy-dom refuses to load any `<script src>` at all ("JavaScript file
 * loading is disabled") and fails every attempt deterministically and
 * synchronously-ish on append — which is exactly the failure path this fix
 * targets, so the tests drive the loaders directly against a real
 * `document` rather than hand-simulating `load`/`error` events. It also
 * means genuine success can't be exercised in this harness; the
 * still-pending memoization case (a strictEqual on two synchronous calls,
 * before either settles) covers the "don't reload while already loading"
 * half instead.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadGoogleIdentityServices,
  loadGooglePicker,
  resetGoogleScriptLoadersForTest,
} from './google-drive-browser-loader.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';

const originalConsoleError = console.error;

describe('google-drive-browser-loader', () => {
  beforeEach(() => {
    resetGoogleScriptLoadersForTest();
    for (const el of Array.from(document.querySelectorAll('script'))) el.remove();
    // happy-dom logs its own internal "JavaScript file loading is disabled"
    // DOMException via console.error on every attempt; that's expected and
    // asserted on indirectly (the promise rejecting), not on log output.
    console.error = () => {};
  });

  afterEach(() => {
    resetGoogleScriptLoadersForTest();
    for (const el of Array.from(document.querySelectorAll('script'))) el.remove();
    console.error = originalConsoleError;
  });

  it('a still-pending load is memoized: two synchronous calls return the same promise', async () => {
    const p1 = loadGoogleIdentityServices();
    const p2 = loadGoogleIdentityServices();
    assert.strictEqual(p1, p2, 'a second call before the first settles must reuse the in-flight promise');
    // Drain it (it will reject, deterministically, in this harness — see
    // the file doc) so it doesn't surface as an unhandled rejection once
    // this test has already moved on.
    await Promise.allSettled([p1, p2]);
  });

  it('loadGoogleIdentityServices does not cache a rejection: a retry gets a new promise, not the stale one', async () => {
    const first = loadGoogleIdentityServices();
    await assert.rejects(first);

    // The failed tag must be gone — otherwise a retry's "already exists"
    // check would find it and falsely resolve without loading anything.
    assert.equal(document.querySelector(`script[src="${GIS_SRC}"]`), null);

    const second = loadGoogleIdentityServices();
    assert.notStrictEqual(second, first, 'a retry after a rejection must not be the same cached promise');
    await assert.rejects(second); // the retry genuinely re-ran, and (deterministically, in this harness) failed again
  });

  it('loadGooglePicker does not cache a rejection: a retry gets a new promise, not the stale one', async () => {
    const first = loadGooglePicker();
    await assert.rejects(first);
    assert.equal(document.querySelector(`script[src="${GAPI_SRC}"]`), null);

    const second = loadGooglePicker();
    assert.notStrictEqual(second, first, 'a retry after a rejection must not be the same cached promise');
    await assert.rejects(second);
  });
});
