/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  signRoomToken,
  verifyRoomToken,
  createRoomTokenAuthenticator,
} from '../src/room-token.js';
import { startCollabServer, MemoryPersistence } from '../src/server.js';

const SECRET = 'test-secret-do-not-use-in-prod';

describe('signRoomToken / verifyRoomToken', () => {
  it('round-trips claims for a valid token', () => {
    const token = signRoomToken({ roomId: 'm/abc', role: 'editor', secret: SECRET });
    const claims = verifyRoomToken(token, { secret: SECRET });
    expect(claims).not.toBeNull();
    expect(claims?.room).toBe('m/abc');
    expect(claims?.role).toBe('editor');
    expect(typeof claims?.jti).toBe('string');
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
  });

  it('rejects a tampered payload', () => {
    const token = signRoomToken({ roomId: 'm/abc', role: 'viewer', secret: SECRET });
    const [h, , s] = token.split('.');
    // Forge an editor payload but keep the viewer signature.
    const forgedPayload = Buffer.from(JSON.stringify({ room: 'm/abc', role: 'editor', iat: 1, exp: 9e9, jti: 'x' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyRoomToken(`${h}.${forgedPayload}.${s}`, { secret: SECRET })).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signRoomToken({ roomId: 'm/abc', role: 'editor', secret: SECRET });
    expect(verifyRoomToken(token, { secret: 'other-secret' })).toBeNull();
  });

  it('rejects an expired token (beyond clock tolerance)', () => {
    const t0 = 1_000_000_000_000;
    const token = signRoomToken({ roomId: 'm/abc', role: 'editor', secret: SECRET, ttlSeconds: 60, now: () => t0 });
    // 10 minutes later
    const later = t0 + 10 * 60 * 1000;
    expect(verifyRoomToken(token, { secret: SECRET, now: () => later })).toBeNull();
  });

  it('enforces the room claim when a room is supplied', () => {
    const token = signRoomToken({ roomId: 'm/abc', role: 'editor', secret: SECRET });
    expect(verifyRoomToken(token, { secret: SECRET, room: 'm/abc' })).not.toBeNull();
    expect(verifyRoomToken(token, { secret: SECRET, room: 'm/other' })).toBeNull();
  });

  it('resolves the secret by kid (rotation)', () => {
    const token = signRoomToken({ roomId: 'm/abc', role: 'editor', secret: 'v2-secret', kid: 'v2' });
    const claims = verifyRoomToken(token, {
      secret: (kid) => (kid === 'v2' ? 'v2-secret' : 'v1-secret'),
    });
    expect(claims?.kid).toBe('v2');
    // Unknown kid → no secret → reject.
    expect(verifyRoomToken(token, { secret: (kid) => (kid === 'v1' ? 'v1-secret' : undefined) })).toBeNull();
  });

  it('returns null for malformed input rather than throwing', () => {
    expect(verifyRoomToken('', { secret: SECRET })).toBeNull();
    expect(verifyRoomToken('not-a-jwt', { secret: SECRET })).toBeNull();
    expect(verifyRoomToken('a.b.c', { secret: SECRET })).toBeNull();
  });
});

describe('createRoomTokenAuthenticator', () => {
  it('authorizes a connection and derives the role from the token', async () => {
    const authenticate = createRoomTokenAuthenticator({ secret: SECRET });
    const token = signRoomToken({ roomId: 'm/abc', role: 'commenter', secret: SECRET });
    const principal = await authenticate(token, 'm/abc');
    expect(principal?.role).toBe('commenter');
    expect(principal?.userId.startsWith('anon-')).toBe(true);
    expect(principal?.meta).toMatchObject({ room: 'm/abc' });
  });

  it('rejects when the token is for a different room', async () => {
    const authenticate = createRoomTokenAuthenticator({ secret: SECRET });
    const token = signRoomToken({ roomId: 'm/abc', role: 'editor', secret: SECRET });
    expect(await authenticate(token, 'm/other')).toBeNull();
  });

  it('rejects a revoked jti', async () => {
    const revoked = new Set<string>();
    const authenticate = createRoomTokenAuthenticator({
      secret: SECRET,
      isRevoked: (jti) => revoked.has(jti),
    });
    const token = signRoomToken({ roomId: 'm/abc', role: 'editor', secret: SECRET });
    const ok = await authenticate(token, 'm/abc');
    expect(ok).not.toBeNull();
    revoked.add(ok!.meta!.jti as string);
    expect(await authenticate(token, 'm/abc')).toBeNull();
  });

  it('rejects a missing token', async () => {
    const authenticate = createRoomTokenAuthenticator({ secret: SECRET });
    expect(await authenticate(undefined, 'm/abc')).toBeNull();
  });
});

describe('POST /collab/token mint route', () => {
  it('mints a verifiable token when authorized, and 403s when denied', async () => {
    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      authenticate: createRoomTokenAuthenticator({ secret: SECRET }),
      tokenEndpoint: {
        secret: SECRET,
        // Policy for the test: grant the requested role except `admin`.
        authorize: (req) => (req.role === 'admin' ? null : req.role),
      },
    });
    const address = handle.httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      // Authorized mint.
      const ok = await fetch(`http://127.0.0.1:${port}/collab/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'm/abc', role: 'editor' }),
      });
      expect(ok.status).toBe(200);
      const { token, role } = await ok.json();
      expect(role).toBe('editor');
      const claims = verifyRoomToken(token, { secret: SECRET, room: 'm/abc' });
      expect(claims?.role).toBe('editor');

      // Denied by policy.
      const denied = await fetch(`http://127.0.0.1:${port}/collab/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'm/abc', role: 'admin' }),
      });
      expect(denied.status).toBe(403);

      // Malformed request.
      const bad = await fetch(`http://127.0.0.1:${port}/collab/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'm/abc', role: 'superuser' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await handle.stop();
    }
  });

  it('returns 404 for the token route when the endpoint is disabled', async () => {
    const handle = await startCollabServer({ port: 0, persistence: new MemoryPersistence() });
    const address = handle.httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/collab/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'm/abc', role: 'editor' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await handle.stop();
    }
  });
});
