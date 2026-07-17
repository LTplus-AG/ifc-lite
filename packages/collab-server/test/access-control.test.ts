/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Access-control policy + persistence for token-secret deployments
 * (`createAccessControl`, used by bin.ts): per-IP mint rate limiting,
 * claimed-rooms cap, revoked-bearer refusal, and the debounced atomic
 * state persistence with its shutdown `flush()`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccessControl } from '../src/access-control.js';
import type { MintRequestBody, RoomTokenClaims } from '../src/room-token.js';
import type { Role } from '../src/auth.js';

const SECRET = 'test-secret-do-not-use-in-prod';

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-access-control-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

type AuthorizeFn = (
  request: MintRequestBody,
  context: { bearerClaims: RoomTokenClaims | null; clientIp: string | undefined },
) => Promise<Role | null> | Role | null;

function authorizeOf(ac: ReturnType<typeof createAccessControl>): AuthorizeFn {
  const endpoint = ac.serverOptions.tokenEndpoint;
  if (!endpoint) throw new Error('tokenEndpoint missing from serverOptions');
  return endpoint.authorize as AuthorizeFn;
}

function adminClaims(room: string, jti = 'admin-jti'): RoomTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return { room, role: 'admin', iat: now, exp: now + 3600, jti };
}

function readState(dir: string): { revoked?: string[]; claimedRooms?: string[] } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'access-control.json'), 'utf8'));
}

describe('mint rate limiting (per client IP)', () => {
  it('allows a burst of 30 fresh-room mints from one IP and refuses the 31st', async () => {
    const ac = createAccessControl({ secret: SECRET, dir: freshDir() });
    const authorize = authorizeOf(ac);
    for (let i = 0; i < 30; i++) {
      const role = await authorize(
        { roomId: `m/burst-${i}`, role: 'editor' },
        { bearerClaims: null, clientIp: '198.51.100.1' },
      );
      expect(role, `mint ${i + 1} should pass`).toBe('admin');
    }
    const blocked = await authorize(
      { roomId: 'm/burst-31', role: 'editor' },
      { bearerClaims: null, clientIp: '198.51.100.1' },
    );
    expect(blocked).toBeNull();
  });

  it('keeps buckets per IP: a drained IP does not affect another', async () => {
    const ac = createAccessControl({ secret: SECRET, dir: freshDir(), mintRateCapacity: 2 });
    const authorize = authorizeOf(ac);
    const mint = (room: string, ip: string) =>
      authorize({ roomId: room, role: 'editor' }, { bearerClaims: null, clientIp: ip });
    expect(await mint('m/a1', '198.51.100.1')).toBe('admin');
    expect(await mint('m/a2', '198.51.100.1')).toBe('admin');
    expect(await mint('m/a3', '198.51.100.1')).toBeNull(); // IP A drained
    expect(await mint('m/b1', '198.51.100.2')).toBe('admin'); // IP B unaffected
  });

  it('missing client IP falls into a shared "unknown" bucket', async () => {
    const ac = createAccessControl({ secret: SECRET, dir: freshDir(), mintRateCapacity: 1 });
    const authorize = authorizeOf(ac);
    expect(
      await authorize({ roomId: 'm/u1', role: 'editor' }, { bearerClaims: null, clientIp: undefined }),
    ).toBe('admin');
    // Second unknown-IP caller shares the drained bucket (no fresh bucket per
    // request when the IP is unattributable).
    expect(
      await authorize({ roomId: 'm/u2', role: 'editor' }, { bearerClaims: null, clientIp: '' }),
    ).toBeNull();
  });

  it('bounds the per-IP limiter map: oldest entries are evicted past the cap', async () => {
    const ac = createAccessControl({
      secret: SECRET,
      dir: freshDir(),
      mintRateCapacity: 1,
      maxRateLimiters: 8,
    });
    const authorize = authorizeOf(ac);
    const mint = (room: string, ip: string) =>
      authorize({ roomId: room, role: 'editor' }, { bearerClaims: null, clientIp: ip });
    // Drain IP0's one-token bucket.
    expect(await mint('m/e0', '10.0.0.0')).toBe('admin');
    expect(await mint('m/e0b', '10.0.0.0')).toBeNull();
    // Fill the map to its 8-entry cap and one past it (forces eviction of the
    // oldest ~1/8th, which includes IP0).
    for (let i = 1; i <= 8; i++) {
      expect(await mint(`m/e${i}`, `10.0.0.${i}`)).toBe('admin');
    }
    // IP0 was evicted, so it gets a fresh bucket: the map cannot be wedged
    // into a permanent-deny (or unbounded-growth) state by an IP spray.
    expect(await mint('m/e0c', '10.0.0.0')).toBe('admin');
  });

  it('exempts authenticated admin re-mints from the per-IP budget', async () => {
    const ac = createAccessControl({ secret: SECRET, dir: freshDir(), mintRateCapacity: 1 });
    const authorize = authorizeOf(ac);
    // Claim the room (consumes the IP's only token).
    expect(
      await authorize({ roomId: 'm/room', role: 'editor' }, { bearerClaims: null, clientIp: '203.0.113.9' }),
    ).toBe('admin');
    // Bucket drained: a fresh-room mint from this IP is refused...
    expect(
      await authorize({ roomId: 'm/other', role: 'editor' }, { bearerClaims: null, clientIp: '203.0.113.9' }),
    ).toBeNull();
    // ...but the room's admin re-minting a link from the same drained IP works.
    expect(
      await authorize(
        { roomId: 'm/room', role: 'viewer' },
        { bearerClaims: adminClaims('m/room'), clientIp: '203.0.113.9' },
      ),
    ).toBe('viewer');
  });

  it('refuses a revoked bearer even when its signature and expiry still verify', async () => {
    const ac = createAccessControl({ secret: SECRET, dir: freshDir() });
    const authorize = authorizeOf(ac);
    expect(
      await authorize({ roomId: 'm/room', role: 'editor' }, { bearerClaims: null, clientIp: '1.1.1.1' }),
    ).toBe('admin');
    const revokeEndpoint = ac.serverOptions.revokeEndpoint;
    if (!revokeEndpoint) throw new Error('revokeEndpoint missing');
    await revokeEndpoint.recordRevocation('admin-jti', 'm/room');
    // The revoked admin bearer must not keep minting; nor may it fall through
    // to a fresh-room grant (the room is already claimed).
    expect(
      await authorize(
        { roomId: 'm/room', role: 'viewer' },
        { bearerClaims: adminClaims('m/room', 'admin-jti'), clientIp: '1.1.1.2' },
      ),
    ).toBeNull();
  });
});

describe('claimedRooms cap', () => {
  it('allows claims up to the cap and refuses the first one past it', async () => {
    const ac = createAccessControl({
      secret: SECRET,
      dir: freshDir(),
      maxClaimedRooms: 3,
      mintRateCapacity: 100,
    });
    const authorize = authorizeOf(ac);
    const mint = (room: string) =>
      authorize({ roomId: room, role: 'editor' }, { bearerClaims: null, clientIp: '2.2.2.2' });
    expect(await mint('m/c1')).toBe('admin');
    expect(await mint('m/c2')).toBe('admin');
    expect(await mint('m/c3')).toBe('admin'); // cap-th claim still fits
    expect(await mint('m/c4')).toBeNull(); // cap+1 refused
    // An already-claimed room is unaffected by the cap refusal path (still the
    // regular claimed-room denial for a non-admin caller).
    expect(await mint('m/c1')).toBeNull();
  });
});

describe('state persistence (debounced, atomic, flushable)', () => {
  it('persists claims and revocations atomically and reloads them', async () => {
    const dir = freshDir();
    const ac = createAccessControl({ secret: SECRET, dir, persistDebounceMs: 1 });
    const authorize = authorizeOf(ac);
    expect(
      await authorize({ roomId: 'm/persist', role: 'editor' }, { bearerClaims: null, clientIp: '3.3.3.3' }),
    ).toBe('admin');
    await ac.serverOptions.revokeEndpoint!.recordRevocation('revoked-jti', 'm/persist');
    await ac.flush();

    const state = readState(dir);
    expect(state.claimedRooms).toContain('m/persist');
    expect(state.revoked).toContain('revoked-jti');
    // Atomic write: no torn temp file left behind.
    expect(fs.existsSync(path.join(dir, 'access-control.json.tmp'))).toBe(false);

    // A fresh instance reloads the state: the room stays claimed and the
    // revoked jti stays refused.
    const ac2 = createAccessControl({ secret: SECRET, dir });
    const authorize2 = authorizeOf(ac2);
    expect(
      await authorize2({ roomId: 'm/persist', role: 'editor' }, { bearerClaims: null, clientIp: '3.3.3.4' }),
    ).toBeNull();
    expect(
      await authorize2(
        { roomId: 'm/persist', role: 'viewer' },
        { bearerClaims: adminClaims('m/persist', 'revoked-jti'), clientIp: '3.3.3.4' },
      ),
    ).toBeNull();
  });

  it('does not lose a claim that lands while a write is in flight', async () => {
    const dir = freshDir();
    const ac = createAccessControl({ secret: SECRET, dir, persistDebounceMs: 1 });
    const authorize = authorizeOf(ac);
    const mint = (room: string) =>
      authorize({ roomId: room, role: 'editor' }, { bearerClaims: null, clientIp: '4.4.4.4' });
    await mint('m/first');
    // Start the flush (kicks the write) and land another claim before awaiting
    // it: the dirty re-flush must capture the second claim before flush()
    // resolves.
    const flushing = ac.flush();
    await mint('m/second');
    await flushing;
    await ac.flush();
    const state = readState(dir);
    expect(state.claimedRooms).toContain('m/first');
    expect(state.claimedRooms).toContain('m/second');
  });

  it('rapid claim/revoke interleaving ends with the correct final state on disk', async () => {
    const dir = freshDir();
    const ac = createAccessControl({
      secret: SECRET,
      dir,
      persistDebounceMs: 1,
      mintRateCapacity: 100,
    });
    const authorize = authorizeOf(ac);
    for (let i = 0; i < 20; i++) {
      await authorize(
        { roomId: `m/t${i}`, role: 'editor' },
        { bearerClaims: null, clientIp: '5.5.5.5' },
      );
      await ac.serverOptions.revokeEndpoint!.recordRevocation(`jti-${i}`, `m/t${i}`);
    }
    await ac.flush();
    const state = readState(dir);
    for (let i = 0; i < 20; i++) {
      expect(state.claimedRooms).toContain(`m/t${i}`);
      expect(state.revoked).toContain(`jti-${i}`);
    }
    expect(fs.existsSync(path.join(dir, 'access-control.json.tmp'))).toBe(false);
  });

  it('flush() is a no-op when there is nothing pending', async () => {
    const dir = freshDir();
    const ac = createAccessControl({ secret: SECRET, dir });
    await ac.flush();
    expect(fs.existsSync(path.join(dir, 'access-control.json'))).toBe(false);
  });
});
