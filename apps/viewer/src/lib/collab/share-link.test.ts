/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * share-link.ts had zero test coverage. It has two shapes worth pinning:
 *
 *   - server vs. local-only mode branch on `collabServerUrl()` — a live
 *     collab server that rejects, times out, or answers with a malformed body
 *     must not be treated as success, and local-only mode must not silently
 *     pretend a privileged op (revoke/kick) succeeded.
 *   - `parseRoleFromToken` decodes untrusted, possibly-malformed input
 *     (an opaque server-signed token, or garbage) and must fail closed (null),
 *     never throw and never accept a role the type doesn't allow.
 *
 * `collabServerUrl()` reads `import.meta.env.VITE_COLLAB_SERVER_URL`, which
 * `vite-module-hooks-impl.mjs` shims to `globalThis.__VITE_ENV__` under
 * `tsx --test` — so toggling that object between tests exercises both the
 * server and local-only branches of the SAME module without a build step.
 * No real network calls are made: `fetch` is stubbed per test.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  mintRoomId,
  mintRoomToken,
  revokeRoomToken,
  kickRoomPeer,
  parseRoleFromToken,
  buildShareUrl,
} from './share-link.js';

type Env = { VITE_COLLAB_SERVER_URL?: string };
/**
 * `vite-module-hooks-impl.mjs` binds `import.meta.env` to
 * `(globalThis.__VITE_ENV__ ??= {...})` — a `??=`, evaluated once, at the
 * FIRST module that reads it. Every module sharing that binding therefore
 * sees the SAME object thereafter; replacing `globalThis.__VITE_ENV__`
 * wholesale (`g.__VITE_ENV__ = {...}`) leaves already-loaded modules pointing
 * at the stale object. Mutate the existing object's property instead.
 */
function setServerUrl(url: string | undefined): void {
  const g = globalThis as unknown as { __VITE_ENV__?: Env };
  g.__VITE_ENV__ ??= {};
  if (url === undefined) delete g.__VITE_ENV__.VITE_COLLAB_SERVER_URL;
  else g.__VITE_ENV__.VITE_COLLAB_SERVER_URL = url;
}

const originalFetch = globalThis.fetch;
function stubFetch(fn: typeof fetch): void {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

beforeEach(() => {
  setServerUrl(undefined);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setServerUrl(undefined);
});

describe('mintRoomId', () => {
  it('mints a short, URL-friendly, non-empty id', () => {
    const id = mintRoomId();
    assert.ok(id.length > 0);
    assert.match(id, /^[A-Za-z0-9_-]+$/);
  });

  it('does not repeat across calls (collision-safe at test scale)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintRoomId()));
    assert.equal(ids.size, 50);
  });
});

describe('mintRoomToken — local-only mode (no server configured)', () => {
  it('returns a decodable dev placeholder round-tripping room/role', async () => {
    const token = await mintRoomToken({ roomId: 'room-1', role: 'editor' });
    assert.equal(parseRoleFromToken(token), 'editor');
  });

  it('never calls fetch when no server is configured', async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      throw new Error('must not be called in local-only mode');
    });
    await mintRoomToken({ roomId: 'room-1', role: 'viewer' });
    assert.equal(called, false);
  });
});

describe('mintRoomToken — server mode', () => {
  it('returns the server-minted token on success', async () => {
    setServerUrl('wss://collab.example.test');
    stubFetch(async (input) => {
      assert.equal(String(input), 'https://collab.example.test/collab/token');
      return new Response(JSON.stringify({ token: 'signed.jwt.token' }), { status: 200 });
    });
    const token = await mintRoomToken({ roomId: 'room-1', role: 'admin' });
    assert.equal(token, 'signed.jwt.token');
  });

  it('rejects on a non-ok HTTP status rather than returning an empty/placeholder token', async () => {
    setServerUrl('wss://collab.example.test');
    stubFetch(async () => new Response('nope', { status: 403 }));
    await assert.rejects(
      () => mintRoomToken({ roomId: 'room-1', role: 'viewer' }),
      /token mint failed \(403\)/,
    );
  });

  it('rejects on a 200 with a malformed body (no token field)', async () => {
    setServerUrl('wss://collab.example.test');
    stubFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await assert.rejects(() => mintRoomToken({ roomId: 'room-1', role: 'viewer' }), /returned no token/);
  });
});

describe('revokeRoomToken', () => {
  it('is a no-op (false) in local-only mode — it must not claim success it cannot deliver', async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const revoked = await revokeRoomToken('some-token', 'bearer');
    assert.equal(revoked, false);
    assert.equal(called, false, 'no network call in local-only mode');
  });

  it('reflects the server response in server mode', async () => {
    setServerUrl('wss://collab.example.test');
    stubFetch(async () => new Response(null, { status: 200 }));
    assert.equal(await revokeRoomToken('tok', 'bearer'), true);
  });

  it('returns false when the server rejects the revoke', async () => {
    setServerUrl('wss://collab.example.test');
    stubFetch(async () => new Response(null, { status: 401 }));
    assert.equal(await revokeRoomToken('tok', 'bearer'), false);
  });
});

describe('kickRoomPeer', () => {
  it('is a no-op (false) in local-only mode', async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return new Response(JSON.stringify({ kicked: true }), { status: 200 });
    });
    assert.equal(await kickRoomPeer('room-1', 42, 'bearer'), false);
    assert.equal(called, false);
  });

  it('returns true only when the server body says kicked === true', async () => {
    setServerUrl('wss://collab.example.test');
    stubFetch(async () => new Response(JSON.stringify({ kicked: true }), { status: 200 }));
    assert.equal(await kickRoomPeer('room-1', 42, 'bearer'), true);
  });

  it('returns false on an ok response whose body does not confirm the kick', async () => {
    // A malformed/absent confirmation must not be treated as success — the
    // admin UI would tell the caller "peer removed" when nothing happened.
    setServerUrl('wss://collab.example.test');
    stubFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    assert.equal(await kickRoomPeer('room-1', 42, 'bearer'), false);
  });

  it('returns false on a non-ok status without inspecting the body', async () => {
    setServerUrl('wss://collab.example.test');
    stubFetch(async () => new Response(JSON.stringify({ kicked: true }), { status: 500 }));
    assert.equal(await kickRoomPeer('room-1', 42, 'bearer'), false);
  });
});

describe('parseRoleFromToken', () => {
  it('round-trips a role through the dev placeholder for every valid role', async () => {
    for (const role of ['viewer', 'commenter', 'editor', 'admin'] as const) {
      const token = await mintRoomToken({ roomId: 'r', role });
      assert.equal(parseRoleFromToken(token), role);
    }
  });

  it('decodes the middle segment of a real 3-part JWT shape', () => {
    const payload = { role: 'editor' };
    const b64url = (s: string) =>
      Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`;
    assert.equal(parseRoleFromToken(jwt), 'editor');
  });

  it('returns null for a role the type does not allow, rather than passing it through', () => {
    const b64url = (s: string) =>
      Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = b64url(JSON.stringify({ role: 'superadmin' }));
    assert.equal(parseRoleFromToken(token), null);
  });

  it('fails closed (null) on garbage input rather than throwing', () => {
    assert.equal(parseRoleFromToken('not-base64-!!!'), null);
    assert.equal(parseRoleFromToken(''), null);
  });

  it('fails closed on valid base64 that is not JSON', () => {
    const b64url = Buffer.from('just some bytes', 'utf8').toString('base64');
    assert.equal(parseRoleFromToken(b64url), null);
  });
});

describe('buildShareUrl', () => {
  it('encodes room and token as query params', () => {
    const url = buildShareUrl('room-1', 'tok en/with+special');
    const parsed = new URL(url.startsWith('?') ? `http://x${url}` : url);
    assert.equal(parsed.searchParams.get('room'), 'room-1');
    assert.equal(parsed.searchParams.get('t'), 'tok en/with+special');
  });
});
