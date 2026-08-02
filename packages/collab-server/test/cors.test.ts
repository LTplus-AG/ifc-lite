/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { startCollabServer, type CollabServerHandle } from '../src/server.js';
import { MemoryPersistence } from '../src/persistence.js';

const HASH = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost:3000';

let handle: CollabServerHandle | null = null;
afterEach(async () => {
  await handle?.stop();
  handle = null;
});

async function start(opts: Parameters<typeof startCollabServer>[0] = {}) {
  handle = await startCollabServer({ port: 0, persistence: new MemoryPersistence(), ...opts });
  const { port } = handle.httpServer.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

describe('CORS', () => {
  it('answers a blob OPTIONS preflight with permissive headers by default', async () => {
    const base = await start();
    const res = await fetch(`${base}/blobs/${HASH}`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,authorization',
      },
    });
    expect(res.status).toBe(204);
    // Reflects the caller's origin (works for both credentialed + COEP fetches).
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    await res.body?.cancel();
  });

  it('exposes blob bytes cross-origin on GET (ACAO + CORP)', async () => {
    const base = await start();
    const res = await fetch(`${base}/blobs`, { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    await res.json();
  });

  it('restricts to an allow-list when origin is configured', async () => {
    const base = await start({ cors: { origin: ['https://app.example.com'] } });
    const blocked = await fetch(`${base}/blobs`, { headers: { origin: ORIGIN } });
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
    await blocked.body?.cancel();

    const allowed = await fetch(`${base}/blobs`, {
      headers: { origin: 'https://app.example.com' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    await allowed.json();
  });

  it('omits CORS headers entirely when disabled', async () => {
    const base = await start({ cors: false });
    const res = await fetch(`${base}/blobs`, { headers: { origin: ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    // OPTIONS still short-circuits, but without CORS headers.
    await res.json();
  });
});
