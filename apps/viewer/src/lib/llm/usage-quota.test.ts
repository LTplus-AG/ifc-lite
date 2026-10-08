/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fetchUsageSnapshot } from './usage-quota.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; mock.restoreAll(); });

test('the documented GET ?usage=1 body is read as the free request quota', async () => {
  let url = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    url = String(input);
    return new Response(JSON.stringify({ usage: { type: 'requests', used: 5, limit: 50, pct: 10, resetAt: 1_700_000_000 } }));
  }) as typeof fetch;
  assert.deepEqual(await fetchUsageSnapshot('/api/chat'), { ok: true, usage: { type: 'requests', used: 5, limit: 50, pct: 10, resetAt: 1_700_000_000 } });
  assert.equal(url, '/api/chat?usage=1');
});

test('quota failures are logged and returned as a reason instead of disappearing', async () => {
  const warn = mock.method(console, 'warn', () => undefined);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Usage service failed', code: 'usage_store_error' }), { status: 502 })) as typeof fetch;
  assert.deepEqual(await fetchUsageSnapshot('/api/chat'), { ok: false, reason: 'HTTP 502' });
  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  assert.deepEqual(await fetchUsageSnapshot('/api/chat'), { ok: false, reason: 'network error' });
  globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
  assert.deepEqual(await fetchUsageSnapshot('/api/chat'), { ok: false, reason: 'response carried no usage' });
  assert.equal(warn.mock.callCount(), 3);
});
