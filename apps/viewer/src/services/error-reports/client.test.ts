/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReportClient } from './client';
test('#7495 curated service errors explain recovery without exposing raw responses', async () => {
  const client = new ReportClient(async () => Response.json({ error: 'upload_quota', message: 'Daily upload allowance reached.' }, { status: 429 }));
  await assert.rejects(client.request('/drafts', 'POST', {}), { message: 'Daily upload allowance reached.' });
});
test('#7495 malformed and oversized service errors use a bounded status fallback', async () => {
  for (const body of [{ message: 'x'.repeat(501) }, { message: { secret: 'private' } }, { message: 'bad\u0000value' }]) {
    const client = new ReportClient(async () => Response.json(body, { status: 503 }));
    await assert.rejects(client.request('/session'), { message: 'Reporting request failed (503)' });
  }
  const html = new ReportClient(async () => new Response('<html>Private proxy error</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(html.request('/session'), { message: 'Reporting request failed (502)' });
});

test('#7495 native fetch retains its Window receiver instead of the ReportClient receiver', async (context) => {
  context.mock.method(globalThis, 'fetch', async function (this: unknown) {
    assert.equal(this, globalThis, 'browser fetch rejects an illegal receiver');
    return Response.json({ ok: true });
  });
  assert.deepEqual(await new ReportClient().request('/session'), { ok: true });
});
