/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6581: a fresh-room claim whose room is never created (seed preparation or
 * the join failed after the admin token was minted) must not hold its slot in
 * the claim allowance forever. Drives `createAccessControl` through the real
 * token, release and websocket routes of `startCollabServer`.
 *
 * Who may release, what can never be released, that a released or expired
 * claim's tokens are dead, and that every transition survives a restart.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccessControl, type AccessControl, type AccessControlOptions } from '../src/access-control.js';
import { startCollabServer, type CollabServerHandle } from '../src/server.js';
import { MemoryPersistence } from '../src/persistence.js';
import { signRoomToken, verifyRoomToken, type RoomTokenClaims } from '../src/room-token.js';

const SECRET = 'test-secret-6581';

const tmpDirs: string[] = [];
const instances: AccessControl[] = [];
const handles: CollabServerHandle[] = [];
let clock = Date.now();
const now = () => clock;

afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const ac of instances.splice(0)) await ac.flush().catch(() => {});
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  clock = Date.now();
});

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-claims-'));
  tmpDirs.push(dir);
  return dir;
}

/** The bin's configuration: the server uses `serverOptions.authenticate` as is. */
function create(dir: string, extra: Partial<AccessControlOptions> = {}): AccessControl {
  const ac = createAccessControl({
    secret: SECRET,
    dir,
    now,
    persistDebounceMs: 1,
    mintRateCapacity: 100,
    claimsPendingUntilJoin: true,
    ...extra,
  });
  instances.push(ac);
  return ac;
}

/** A deployment that keeps the token and release routes but authenticates joins itself. */
async function serveWithOwnAuthenticate(ac: AccessControl): Promise<string> {
  const handle = await startCollabServer({
    port: 0,
    persistence: new MemoryPersistence(),
    ...ac.serverOptions,
    authenticate: (token, room) => {
      const claims = verifyRoomToken(token ?? '', { secret: SECRET, room, now });
      return claims ? { userId: `own-${claims.jti}`, role: claims.role } : null;
    },
  });
  handles.push(handle);
  return `http://127.0.0.1:${(handle.httpServer.address() as { port: number }).port}`;
}

async function serve(ac: AccessControl): Promise<string> {
  const handle = await startCollabServer({ port: 0, persistence: new MemoryPersistence(), ...ac.serverOptions });
  handles.push(handle);
  return `http://127.0.0.1:${(handle.httpServer.address() as { port: number }).port}`;
}

const post = (url: string, body: object, bearer?: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });

async function mint(
  base: string,
  roomId: string,
  opts: { role?: string; bearer?: string; ttlSeconds?: number } = {},
): Promise<{ status: number; token?: string; role?: string }> {
  const res = await post(`${base}/collab/token`, { roomId, role: opts.role ?? 'admin', ttlSeconds: opts.ttlSeconds }, opts.bearer);
  if (res.status !== 200) return { status: res.status };
  const json = (await res.json()) as { token: string; role: string };
  return { status: 200, token: json.token, role: json.role };
}

async function release(base: string, roomId: string, bearer?: string): Promise<number> {
  return (await post(`${base}/collab/release`, { roomId }, bearer)).status;
}

/** Connect and report whether the server admitted the peer (it sends sync step 1) or refused it. */
function join(base: string, roomId: string, token: string): Promise<'admitted' | 'refused'> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/${encodeURIComponent(roomId)}?token=${token}`);
  return new Promise((resolve, reject) => {
    ws.once('message', () => {
      resolve('admitted');
      ws.close();
    });
    ws.once('close', () => resolve('refused'));
    ws.once('error', reject);
  });
}

function stateOf(dir: string): { claimedRooms?: string[]; pendingClaims?: Record<string, unknown>; revoked?: Record<string, number> } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'access-control.json'), 'utf8'));
}

function claimsOf(token: string): RoomTokenClaims {
  const claims = verifyRoomToken(token, { secret: SECRET, now });
  if (!claims) throw new Error('fixture token did not verify');
  return claims;
}

describe('#6581 releasing an unused fresh-room claim', () => {
  it('repeated failed creations no longer exhaust the claim allowance', async () => {
    const dir = freshDir();
    const base = await serve(create(dir, { maxClaimedRooms: 2 }));
    // Each attempt mints the admin token, then fails before joining (the
    // seed could not be prepared) and hands the claim back.
    for (let attempt = 0; attempt < 5; attempt++) {
      const admin = await mint(base, `failed-${attempt}`);
      expect(admin.status, `attempt ${attempt} claims a fresh room`).toBe(200);
      expect(await release(base, `failed-${attempt}`, admin.token), `attempt ${attempt} releases`).toBe(200);
    }
    // The allowance is intact: two fresh rooms still fit.
    expect((await mint(base, 'real-1')).status).toBe(200);
    expect((await mint(base, 'real-2')).status).toBe(200);
    expect((await mint(base, 'real-3')).status, 'the cap itself still holds').toBe(403);
    const ac = instances[0];
    await ac.flush();
    expect(stateOf(dir).claimedRooms?.sort()).toEqual(['real-1', 'real-2']);
  });

  it('needs an admin bearer for the room: no bearer, garbage, a link of another role or another room is refused', async () => {
    const base = await serve(create(freshDir()));
    const admin = await mint(base, 'held');
    const viewer = await mint(base, 'held', { role: 'viewer', bearer: admin.token });
    expect(viewer.role).toBe('viewer');
    const otherRoom = await mint(base, 'someone-else');

    expect(await release(base, 'held'), 'no bearer').toBe(403);
    expect(await release(base, 'held', 'not-a-token'), 'garbage bearer').toBe(403);
    expect(await release(base, 'held', viewer.token), 'a viewer link minted for the claim').toBe(403);
    expect(await release(base, 'held', otherRoom.token), 'the admin of another room').toBe(403);
    expect(await join(base, 'held', admin.token!), 'refused attempts leave the claim intact').toBe('admitted');
  });

  it('needs an admin token the claim itself minted, not merely a valid one for the room', async () => {
    const base = await serve(create(freshDir()));
    const admin = await mint(base, 'held');
    // Correctly signed for the room, but never handed out by this claim.
    const unrelated = signRoomToken({ roomId: 'held', role: 'admin', secret: SECRET, now });
    expect(await release(base, 'held', unrelated)).toBe(403);
    expect(await release(base, 'held', admin.token)).toBe(200);
  });

  it('a revoked admin token cannot release', async () => {
    const ac = create(freshDir());
    const base = await serve(ac);
    const admin = await mint(base, 'revoked-holder');
    const second = await mint(base, 'revoked-holder', { bearer: admin.token });
    expect((await post(`${base}/collab/revoke`, { token: second.token }, admin.token)).status).toBe(200);
    expect(await release(base, 'revoked-holder', second.token)).toBe(403);
    // The route's own check awaits; a revocation landing in that gap is
    // caught again where the release happens.
    expect(await ac.serverOptions.releaseEndpoint!.release(claimsOf(second.token!))).toBe('not-holder');
    expect(await release(base, 'revoked-holder', admin.token)).toBe(200);
  });

  it('never releases a room that was joined', async () => {
    const dir = freshDir();
    const base = await serve(create(dir));
    const admin = await mint(base, 'joined');
    expect(await join(base, 'joined', admin.token!)).toBe('admitted');
    expect(await release(base, 'joined', admin.token)).toBe(409);
    expect(await join(base, 'joined', admin.token!), 'the owner keeps access').toBe('admitted');
    expect((await mint(base, 'joined')).status, 'and nobody can first-claim it').toBe(403);
  });

  it('never releases or expires a room that holds persisted data', async () => {
    const dir = freshDir();
    const base = await serve(create(dir, { maxClaimedRooms: 2 }));
    const admin = await mint(base, 'has-data', { ttlSeconds: 60 });
    // Room data written without a join through this access control (a
    // deployment that replaced `authenticate`, say).
    fs.writeFileSync(path.join(dir, `${encodeURIComponent('has-data')}.log`), 'x');
    expect(await release(base, 'has-data', admin.token)).toBe(409);
    clock += 3600_000;
    expect((await mint(base, 'other')).status).toBe(200);
    expect((await mint(base, 'has-data')).status, 'still claimed after its token expired').toBe(403);
  });

  it("a released claim's tokens are dead, even after another client claims the same id", async () => {
    const base = await serve(create(freshDir()));
    const admin = await mint(base, 'recycled');
    const editor = await mint(base, 'recycled', { role: 'editor', bearer: admin.token });
    expect(await release(base, 'recycled', admin.token)).toBe(200);
    expect(await join(base, 'recycled', admin.token!)).toBe('refused');
    expect(await join(base, 'recycled', editor.token!)).toBe('refused');

    const newOwner = await mint(base, 'recycled');
    expect(newOwner.status, 'the id is free again').toBe(200);
    expect(await join(base, 'recycled', newOwner.token!)).toBe('admitted');
    expect(await join(base, 'recycled', admin.token!), 'the old admin cannot enter the new room').toBe('refused');
    expect(await join(base, 'recycled', editor.token!), 'nor can a link it minted').toBe('refused');
    expect((await mint(base, 'recycled', { role: 'viewer', bearer: admin.token })).status, 'nor mint into it').toBe(403);
    expect(await release(base, 'recycled', admin.token), 'nor release it').toBe(403);
  });

  it('bounds what one pending claim can mint, so a release cannot grow the deny-list without limit', async () => {
    const dir = freshDir();
    const base = await serve(create(dir));
    const admin = await mint(base, 'bounded');
    for (let i = 0; i < 3; i++) {
      expect((await mint(base, 'bounded', { role: 'viewer', bearer: admin.token })).status, `mint ${i + 2}`).toBe(200);
    }
    expect((await mint(base, 'bounded', { role: 'viewer', bearer: admin.token })).status, 'the 5th token').toBe(403);
    expect(await release(base, 'bounded', admin.token)).toBe(200);
    await instances[0].flush();
    expect(Object.keys(stateOf(dir).revoked ?? {})).toHaveLength(4);
  });

  it('a joined room mints without that bound', async () => {
    const base = await serve(create(freshDir()));
    const admin = await mint(base, 'live');
    expect(await join(base, 'live', admin.token!)).toBe('admitted');
    for (let i = 0; i < 12; i++) {
      expect((await mint(base, 'live', { role: 'viewer', bearer: admin.token })).status).toBe(200);
    }
  });

  it('releasing does not refund the per-IP fresh-room budget', async () => {
    const base = await serve(create(freshDir(), { mintRateCapacity: 2, mintRateRefillPerSecond: 0.0001 }));
    const a = await mint(base, 'cycle-a');
    expect(await release(base, 'cycle-a', a.token)).toBe(200);
    const b = await mint(base, 'cycle-b');
    expect(b.status).toBe(200);
    expect(await release(base, 'cycle-b', b.token)).toBe(200);
    expect((await mint(base, 'cycle-c')).status).toBe(403);
  });
});

/**
 * Every state write also sweeps expired claims. With the 1 ms test debounce a
 * write can land after the clock jumps and do the expiring itself, which
 * would hide the claim-path expiry under test.
 */
const NO_BACKGROUND_SWEEP = { persistDebounceMs: 60_000 } as const;

describe('#6581 expiry of claims nobody released', () => {
  it('frees the slot once every token minted for the claim has expired', async () => {
    const base = await serve(create(freshDir(), { maxClaimedRooms: 1, ...NO_BACKGROUND_SWEEP }));
    const admin = await mint(base, 'abandoned', { ttlSeconds: 3600 });
    expect(admin.status).toBe(200);
    // The client crashed: no release ever arrives.
    clock += 3600_000 + 59_000;
    expect((await mint(base, 'next')).status, 'not before its token is past expiry plus slack').toBe(403);
    clock += 2_000;
    expect((await mint(base, 'next')).status).toBe(200);
    expect(await join(base, 'abandoned', admin.token!), 'and its token is dead').toBe('refused');
  });

  it("frees the expired claim's own room id below the cap, and its token stays dead", async () => {
    const base = await serve(create(freshDir(), NO_BACKGROUND_SWEEP));
    const admin = await mint(base, 'lapsed', { ttlSeconds: 60 });
    clock += 60_000 + 61_000;
    const next = await mint(base, 'lapsed');
    expect(next.status, 'the id can be claimed again').toBe(200);
    expect(await join(base, 'lapsed', next.token!)).toBe('admitted');
    expect(await join(base, 'lapsed', admin.token!)).toBe('refused');
  });

  it('waits for the longest-lived token the claim minted', async () => {
    const base = await serve(create(freshDir(), { maxClaimedRooms: 1, ...NO_BACKGROUND_SWEEP }));
    const admin = await mint(base, 'long', { ttlSeconds: 60 });
    await mint(base, 'long', { role: 'viewer', bearer: admin.token, ttlSeconds: 7200 });
    clock += 3600_000;
    expect((await mint(base, 'next')).status).toBe(403);
    clock += 3600_000 + 61_000;
    expect((await mint(base, 'next')).status).toBe(200);
  });

  it('a slow but legitimate seed joins at any point before its token expires', async () => {
    const base = await serve(create(freshDir(), { maxClaimedRooms: 1, ...NO_BACKGROUND_SWEEP }));
    const admin = await mint(base, 'slow', { ttlSeconds: 3600 });
    clock += 3600_000 - 1_000;
    expect((await mint(base, 'next')).status, 'a sweep at the cap leaves it').toBe(403);
    expect(await join(base, 'slow', admin.token!)).toBe('admitted');
    clock += 7 * 24 * 3600_000;
    expect((await mint(base, 'next')).status, 'a joined room never expires').toBe(403);
    expect((await mint(base, 'slow')).status).toBe(403);
  });
});

describe('#6581 races', () => {
  it('release vs join: a release landing while the join is being verified wins', async () => {
    const ac = create(freshDir());
    const base = await serve(ac);
    const admin = await mint(base, 'race-join');
    const authenticate = ac.serverOptions.authenticate!;
    const releaseClaim = ac.serverOptions.releaseEndpoint!.release;
    const joining = authenticate(admin.token, 'race-join');
    // The join has verified the token and is awaiting; the release runs now.
    expect(await releaseClaim(claimsOf(admin.token!))).toBe('released');
    expect(await joining, 'the join is refused rather than entering an unclaimed room').toBeNull();
  });

  it('release vs join: a join that confirmed first makes the release fail', async () => {
    const ac = create(freshDir());
    const base = await serve(ac);
    const admin = await mint(base, 'join-first');
    const joining = ac.serverOptions.authenticate!(admin.token, 'join-first');
    const principal = await joining;
    expect(principal?.role).toBe('admin');
    expect(await ac.serverOptions.releaseEndpoint!.release(claimsOf(admin.token!))).toBe('in-use');
  });

  it('release vs join over the network: never both', async () => {
    const base = await serve(create(freshDir()));
    const rooms = Array.from({ length: 12 }, (_, i) => `net-${i}`);
    const tokens = await Promise.all(rooms.map((room) => mint(base, room)));
    const outcomes = await Promise.all(
      rooms.map((room, i) => Promise.all([join(base, room, tokens[i].token!), release(base, room, tokens[i].token)])),
    );
    for (const [i, [joined, released]] of outcomes.entries()) {
      const both = joined === 'admitted' && released === 200;
      const neither = joined === 'refused' && released !== 200;
      expect(both || neither, `${rooms[i]}: join ${joined}, release ${released}`).toBe(false);
    }
  });

  it('release vs a second token request for the same room: no token of the old claim survives', async () => {
    const base = await serve(create(freshDir()));
    const rooms = Array.from({ length: 8 }, (_, i) => `remint-${i}`);
    const admins = await Promise.all(rooms.map((room) => mint(base, room)));
    const results = await Promise.all(
      rooms.map((room, i) =>
        Promise.all([mint(base, room, { role: 'viewer', bearer: admins[i].token }), release(base, room, admins[i].token)]),
      ),
    );
    for (const [i, [reminted, released]] of results.entries()) {
      expect(released, rooms[i]).toBe(200);
      if (reminted.status !== 200) continue;
      // Granted `viewer`: minted inside the old claim, so it died with it.
      // Granted `admin`: the bearer was already revoked, the request fell
      // through to a fresh first-touch claim of the freed id, and that new
      // claim's token is legitimately live.
      const expected = reminted.role === 'viewer' ? 'refused' : 'admitted';
      expect(await join(base, rooms[i], reminted.token!), `${rooms[i]} granted ${reminted.role}`).toBe(expected);
      expect(await join(base, rooms[i], admins[i].token!)).toBe('refused');
    }
  });

  it('revoke vs join: a revocation landing while the join waits for its confirmation write wins', async () => {
    const ac = create(freshDir());
    const admin = await mint(await serve(ac), 'revoked-mid-write');
    await ac.flush();
    const claims = claimsOf(admin.token!);
    // Park the confirmation write at its rename until the revocation has landed.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let parked!: () => void;
    const isParked = new Promise<void>((resolve) => (parked = resolve));
    const rename = fs.promises.rename;
    fs.promises.rename = (async (...args: Parameters<typeof rename>) => {
      parked();
      await gate;
      return rename(...args);
    }) as typeof rename;
    try {
      const joining = ac.serverOptions.authenticate!(admin.token, 'revoked-mid-write');
      await isParked;
      await ac.serverOptions.revokeEndpoint!.recordRevocation(claims.jti, claims.room, claims.exp);
      openGate();
      expect(await joining).toBeNull();
    } finally {
      fs.promises.rename = rename;
    }
  });

  it('expiry vs join: a token expiring during the confirmation write is refused (#6581)', async () => {
    const ac = create(freshDir());
    const admin = await mint(await serve(ac), 'expired-mid-write', { ttlSeconds: 60 });
    await ac.flush();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let parked!: () => void;
    const isParked = new Promise<void>((resolve) => (parked = resolve));
    const rename = fs.promises.rename;
    fs.promises.rename = (async (...args: Parameters<typeof rename>) => {
      parked();
      await gate;
      return rename(...args);
    }) as typeof rename;
    try {
      const joining = ac.serverOptions.authenticate!(admin.token, 'expired-mid-write');
      await isParked;
      clock += 95_000; // token lifetime plus the verifier's 30-second tolerance
      expect(verifyRoomToken(admin.token!, { secret: SECRET, room: 'expired-mid-write', now })).toBeNull();
      openGate();
      expect(await joining).toBeNull();
    } finally {
      openGate();
      fs.promises.rename = rename;
    }
  });

  /**
   * Serve `ac` with its token or release route's revocation check made async
   * and parked until released: the shape of a deployment whose deny-list
   * lives in another store, and the widest window between a route's token
   * check and the action it authorises.
   */
  async function serveWithParkedRevocationCheck(ac: AccessControl, route: 'tokenEndpoint' | 'releaseEndpoint') {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let parked!: () => void;
    const isParked = new Promise<void>((resolve) => (parked = resolve));
    const endpoint = ac.serverOptions[route]!;
    const isRevoked = endpoint.isRevoked!;
    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      ...ac.serverOptions,
      [route]: {
        ...endpoint,
        // Answers as the deny-list stood when asked, like a remote read whose
        // reply is in flight; anything that lands meanwhile is the policy's
        // recheck to catch.
        isRevoked: async (jti: string) => {
          const answer = await isRevoked(jti);
          parked();
          await gate;
          return answer;
        },
      },
    });
    handles.push(handle);
    return { base: `http://127.0.0.1:${(handle.httpServer.address() as { port: number }).port}`, isParked, open };
  }

  it('expiry vs release: an admin token expiring while the release route checks revocation cannot release', async () => {
    const ac = create(freshDir());
    const { base, isParked, open } = await serveWithParkedRevocationCheck(ac, 'releaseEndpoint');
    const admin = await mint(base, 'expired-mid-release', { ttlSeconds: 60 });
    const releasing = release(base, 'expired-mid-release', admin.token);
    await isParked;
    clock += 95_000; // token lifetime plus the verifier's 30-second tolerance
    open();
    expect(await releasing).toBe(403);
    expect((await mint(base, 'expired-mid-release')).status, 'the claim was not released').toBe(403);
  });

  it('revoke vs release: an admin token revoked while the release route checks revocation cannot release', async () => {
    const ac = create(freshDir());
    const { base, isParked, open } = await serveWithParkedRevocationCheck(ac, 'releaseEndpoint');
    const admin = await mint(base, 'revoked-mid-release');
    const claims = claimsOf(admin.token!);
    const releasing = release(base, 'revoked-mid-release', admin.token);
    await isParked;
    await ac.serverOptions.revokeEndpoint!.recordRevocation(claims.jti, claims.room, claims.exp);
    open();
    expect(await releasing).toBe(403);
    expect((await mint(base, 'revoked-mid-release')).status, 'the claim was not released').toBe(403);
  });

  it('expiry vs mint: an admin bearer expiring while the token route checks revocation mints nothing', async () => {
    const ac = create(freshDir());
    const { base, isParked, open } = await serveWithParkedRevocationCheck(ac, 'tokenEndpoint');
    // The first mint has no bearer, so the parked check is not reached.
    const admin = await mint(base, 'expired-mid-mint', { ttlSeconds: 60 });
    const minting = mint(base, 'expired-mid-mint', { role: 'viewer', bearer: admin.token });
    await isParked;
    clock += 95_000;
    open();
    expect((await minting).status).toBe(403);
  });

  it('revoke vs mint: an admin bearer revoked while the token route checks revocation mints nothing', async () => {
    const ac = create(freshDir());
    const { base, isParked, open } = await serveWithParkedRevocationCheck(ac, 'tokenEndpoint');
    const admin = await mint(base, 'revoked-mid-mint');
    const claims = claimsOf(admin.token!);
    const minting = mint(base, 'revoked-mid-mint', { role: 'viewer', bearer: admin.token });
    await isParked;
    await ac.serverOptions.revokeEndpoint!.recordRevocation(claims.jti, claims.room, claims.exp);
    open();
    expect((await minting).status).toBe(403);
  });

  it('expiry vs join: a token that expires while its join is being verified is refused', async () => {
    const ac = create(freshDir());
    const base = await serve(ac);
    const admin = await mint(base, 'expiring', { ttlSeconds: 60 });
    clock += 60_000 + 25_000; // inside the verifier's 30 s tolerance
    const joining = ac.serverOptions.authenticate!(admin.token, 'expiring');
    clock += 10_000; // past it before the join resumes
    expect(await joining).toBeNull();
  });

  it('two concurrent claims at the allowance boundary: exactly one wins', async () => {
    const base = await serve(create(freshDir(), { maxClaimedRooms: 1 }));
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => mint(base, `edge-${i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('a release racing a new claim at the boundary never lets both rooms hold the one slot', async () => {
    const dir = freshDir();
    const ac = create(dir, { maxClaimedRooms: 1 });
    const base = await serve(ac);
    const held = await mint(base, 'slot-holder');
    const [released, newcomer] = await Promise.all([release(base, 'slot-holder', held.token), mint(base, 'newcomer')]);
    expect(released, 'the holder releases in either order').toBe(200);
    expect([200, 403], 'the newcomer either fits after the release or was refused before it').toContain(newcomer.status);
    expect(await join(base, 'slot-holder', held.token!), 'the released claim is dead either way').toBe('refused');
    await ac.flush();
    expect(stateOf(dir).claimedRooms, 'exactly what won the slot, and nothing else').toEqual(
      newcomer.status === 200 ? ['newcomer'] : [],
    );
    if (newcomer.status === 200) expect(await join(base, 'newcomer', newcomer.token!)).toBe('admitted');
    else expect((await mint(base, 'newcomer')).status, 'the freed slot is usable').toBe(200);
  });
});

describe('#6581 durable claim state', () => {
  it('persists a release: after a restart the id is free and its tokens stay dead', async () => {
    const dir = freshDir();
    const ac = create(dir);
    const base = await serve(ac);
    const admin = await mint(base, 'released-durably');
    // The claim is on disk first, so only the release's own write can remove it.
    await ac.flush();
    expect(stateOf(dir).claimedRooms).toContain('released-durably');
    expect(await release(base, 'released-durably', admin.token)).toBe(200);
    await ac.flush();
    expect(stateOf(dir).claimedRooms).not.toContain('released-durably');

    const restarted = create(dir, { maxClaimedRooms: 1 });
    const base2 = await serve(restarted);
    expect(await join(base2, 'released-durably', admin.token!)).toBe('refused');
    expect((await mint(base2, 'fresh-after-restart')).status, 'the slot stayed free').toBe(200);
  });

  it('a restart between claim and release keeps the claim releasable by its holder', async () => {
    const dir = freshDir();
    const ac = create(dir);
    const admin = await mint(await serve(ac), 'across-restart');
    await ac.flush();
    expect(stateOf(dir).claimedRooms, 'an older server reads a pending claim as claimed').toContain('across-restart');

    const restarted = create(dir);
    const base2 = await serve(restarted);
    expect((await mint(base2, 'across-restart')).status, 'not up for grabs after the restart').toBe(403);
    expect(await release(base2, 'across-restart', admin.token)).toBe(200);
    expect(await join(base2, 'across-restart', admin.token!)).toBe('refused');
  });

  it('a join is admitted only once its confirmation is on disk', async () => {
    const dir = freshDir();
    // Default debounce: without the durable confirmation nothing would be
    // written yet when the restart below reads the file.
    const ac = create(dir, { persistDebounceMs: 250 });
    const admin = await mint(await serve(ac), 'confirmed');
    expect(await ac.serverOptions.authenticate!(admin.token, 'confirmed')).not.toBeNull();

    const restarted = create(dir);
    expect(await restarted.serverOptions.releaseEndpoint!.release(claimsOf(admin.token!))).toBe('in-use');
  });

  it('refuses the join when its confirmation cannot be written', async () => {
    const dir = freshDir();
    const ac = create(dir);
    const admin = await mint(await serve(ac), 'unwritable');
    await ac.flush();
    // A directory where the temp file goes makes the write fail for any user,
    // root included (a read-only chmod would not stop root).
    const tmp = path.join(dir, 'access-control.json.tmp');
    fs.mkdirSync(tmp);
    try {
      expect(await ac.serverOptions.authenticate!(admin.token, 'unwritable')).toBeNull();
    } finally {
      fs.rmdirSync(tmp);
    }
    expect(await ac.serverOptions.authenticate!(admin.token, 'unwritable'), 'admitted once it can be written').not.toBeNull();
  });

  it('a state file from before pending claims loads every claim as in use', async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'access-control.json'), JSON.stringify({ revoked: {}, claimedRooms: ['legacy'] }));
    const ac = create(dir);
    const legacyAdmin = signRoomToken({ roomId: 'legacy', role: 'admin', secret: SECRET, now });
    expect(await ac.serverOptions.releaseEndpoint!.release(claimsOf(legacyAdmin))).toBe('in-use');
  });

  it('a ttl JSON spells as infinite neither breaks the token nor poisons the state file', async () => {
    const dir = freshDir();
    const ac = create(dir);
    const base = await serve(ac);
    // `JSON.parse` turns `-1e309` into -Infinity; JSON.stringify cannot write it.
    const res = await fetch(`${base}/collab/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"roomId":"infinite","role":"admin","ttlSeconds":-1e309}',
    });
    const minted = (await res.json()) as { token: string; exp: unknown };
    expect(Number.isFinite(minted.exp), 'falls back to the default ttl').toBe(true);
    await ac.flush();
    const restarted = create(dir);
    expect(await restarted.serverOptions.releaseEndpoint!.release(claimsOf(minted.token))).toBe('released');
  });

  it('a policy caller passing a non-finite expiry cannot poison the state file either', async () => {
    const dir = freshDir();
    const ac = create(dir);
    const authorize = ac.serverOptions.tokenEndpoint!.authorize;
    const granted = await authorize(
      { roomId: 'direct', role: 'admin' },
      // +Infinity: a claim recording it would never expire and would persist as `null`.
      { bearerClaims: null, clientIp: '192.0.2.1', mint: { jti: 'direct-jti', exp: Number.POSITIVE_INFINITY } },
    );
    expect(granted).toBe('admin');
    await ac.flush();
    expect(() => create(dir), 'the server still starts').not.toThrow();
  });

  it('a malformed pendingClaims entry fails closed at startup', () => {
    const dir = freshDir();
    fs.writeFileSync(
      path.join(dir, 'access-control.json'),
      JSON.stringify({ claimedRooms: ['r'], pendingClaims: { r: { at: 'yesterday', tokens: {} } } }),
    );
    expect(() => createAccessControl({ secret: SECRET, dir })).toThrow(/refusing to start open/);
  });
});

describe('#6581 the release path cannot grow the deny-list or the state file without bound', () => {
  /** Claim, mint 3 more tokens with the admin bearer, release: straight through the policy, no HTTP. */
  async function cycle(ac: AccessControl, room: string, ip: string): Promise<string> {
    const authorize = ac.serverOptions.tokenEndpoint!.authorize;
    const exp = Math.floor(clock / 1000) + 30 * 24 * 3600;
    // UUID jtis, as the token route mints them, so the byte counts are real.
    const admin: RoomTokenClaims = { room, role: 'admin', iat: Math.floor(clock / 1000), exp, jti: randomUUID() };
    await authorize({ roomId: room, role: 'admin' }, { bearerClaims: null, clientIp: ip, mint: { jti: admin.jti, exp } });
    for (let k = 1; k < 4; k++) {
      await authorize({ roomId: room, role: 'viewer' }, { bearerClaims: admin, clientIp: ip, mint: { jti: randomUUID(), exp } });
    }
    return ac.serverOptions.releaseEndpoint!.release(admin);
  }

  it('an unauthenticated claim-and-release loop stops adding revocations at the bound', async () => {
    const dir = freshDir();
    const ac = create(dir, { mintRateCapacity: 1e9, maxClaimedRooms: 1_000_000 });
    const results = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const r = await cycle(ac, `loop-${i}`, '198.51.100.7');
      results.set(r, (results.get(r) ?? 0) + 1);
    }
    await ac.flush();
    const state = stateOf(dir);
    const bytes = fs.statSync(path.join(dir, 'access-control.json')).size;
    const entries = Object.keys(state.revoked ?? {}).length;
    const revokedBytes = JSON.stringify(state.revoked).length;
    process.stdout.write(`#6581 loop: ${entries} revocations, ${revokedBytes} B of them, ${bytes} B file\n`);
    expect(entries).toBeLessThanOrEqual(1024);
    expect(revokedBytes, 'the deny-list part of the file').toBeLessThanOrEqual(1024 * 52);
    // The rest is the refused claims, still pending: bounded by the claim cap.
    expect(Object.keys(state.pendingClaims ?? {}).length).toBe(400 - 256);
    expect(results.get('busy'), 'releases past the bound are refused, not dropped').toBeGreaterThan(0);
    // The refused claims stay pending, so they still expire with their tokens.
    clock += 31 * 24 * 3600_000;
    await cycle(ac, 'after-expiry', '198.51.100.8');
    await ac.flush();
    expect(stateOf(dir).claimedRooms, 'every pending claim from the loop expired').toEqual([]);
  });

  it('the bound is configurable and also holds over HTTP, where a refused release answers 503', async () => {
    const dir = freshDir();
    const base = await serve(create(dir, { maxRevocationsForRelease: 3 }));
    const a = await mint(base, 'bound-a');
    await mint(base, 'bound-a', { role: 'viewer', bearer: a.token });
    expect(await release(base, 'bound-a', a.token), '2 entries fit').toBe(200);
    const b = await mint(base, 'bound-b');
    await mint(base, 'bound-b', { role: 'viewer', bearer: b.token });
    expect(await release(base, 'bound-b', b.token), '2 more would make 4').toBe(503);
    expect(await join(base, 'bound-b', b.token!), 'the claim was not released').toBe('admitted');
  });

  it('a mint on a pending claim pays the per-IP budget of a fresh claim', async () => {
    const base = await serve(create(freshDir(), { mintRateCapacity: 3, mintRateRefillPerSecond: 0.0001 }));
    const admin = await mint(base, 'charged');
    expect((await mint(base, 'charged', { role: 'viewer', bearer: admin.token })).status).toBe(200);
    expect((await mint(base, 'charged', { role: 'viewer', bearer: admin.token })).status).toBe(200);
    expect((await mint(base, 'charged', { role: 'viewer', bearer: admin.token })).status, 'budget spent').toBe(403);
    expect(await join(base, 'charged', admin.token!)).toBe('admitted');
    expect((await mint(base, 'charged', { role: 'viewer', bearer: admin.token })).status, 'a joined room is exempt again').toBe(200);
  });
});

describe('#6581 deployments that do not opt in keep every claim (as before #6581)', () => {
  it('with its own authenticate, a joined room is never released', async () => {
    const base = await serveWithOwnAuthenticate(create(freshDir(), { claimsPendingUntilJoin: undefined }));
    const admin = await mint(base, 'own-auth', { ttlSeconds: 60 });
    expect(await join(base, 'own-auth', admin.token!)).toBe('admitted');
    expect(await release(base, 'own-auth', admin.token)).toBe(409);
  });

  it('with its own authenticate, a joined room never expires into a stranger\'s hands', async () => {
    const base = await serveWithOwnAuthenticate(create(freshDir(), { claimsPendingUntilJoin: undefined }));
    const admin = await mint(base, 'own-auth-2', { ttlSeconds: 60 });
    expect(await join(base, 'own-auth-2', admin.token!)).toBe('admitted');
    clock += 200_000;
    expect((await mint(base, 'own-auth-2')).status).toBe(403);
  });

  it('even with the stock authenticate, a claim is permanent unless the deployment opts in', async () => {
    const dir = freshDir();
    const base = await serve(create(dir, { claimsPendingUntilJoin: undefined, maxClaimedRooms: 1 }));
    const admin = await mint(base, 'not-opted-in', { ttlSeconds: 60 });
    expect(await release(base, 'not-opted-in', admin.token)).toBe(409);
    clock += 200_000;
    expect((await mint(base, 'other')).status, 'the slot is held, as on main').toBe(403);
    await instances[0].flush();
    expect(stateOf(dir).pendingClaims).toEqual({});
  });

  it('turning the option off confirms the claims a previous run left pending', async () => {
    const dir = freshDir();
    const ac = create(dir);
    const admin = await mint(await serve(ac), 'left-pending');
    await ac.flush();
    const restarted = create(dir, { claimsPendingUntilJoin: undefined });
    expect(await restarted.serverOptions.releaseEndpoint!.release(claimsOf(admin.token!))).toBe('in-use');
  });
});

describe('#6581 room ids that collide with object keys', () => {
  for (const room of ['__proto__', 'constructor', 'hasOwnProperty']) {
    it(`a pending claim for "${room}" survives the state-file round trip`, async () => {
      const dir = freshDir();
      const ac = create(dir);
      const admin = await mint(await serve(ac), room);
      expect(admin.status).toBe(200);
      await ac.flush();
      const raw = stateOf(dir).pendingClaims!;
      expect(Object.prototype.hasOwnProperty.call(raw, room), 'written as its own key').toBe(true);
      const restarted = create(dir);
      expect(await restarted.serverOptions.releaseEndpoint!.release(claimsOf(admin.token!)), 'still pending').toBe('released');
    });
  }
});

/** An unpaired UTF-16 surrogate: `encodeURIComponent` throws on it. */
const ILL_FORMED = '\ud800';

describe('#6581 room ids that cannot be encoded', () => {
  it('the token and release routes refuse an ill-formed room id at the door', async () => {
    const base = await serve(create(freshDir()));
    const res = await post(`${base}/collab/token`, { roomId: ILL_FORMED, role: 'admin' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-request' });
    const forged = signRoomToken({ roomId: ILL_FORMED, role: 'admin', secret: SECRET, now });
    expect(await release(base, ILL_FORMED, forged)).toBe(400);
    expect((await mint(base, 'well-formed 😀')).status, 'a paired surrogate is fine').toBe(200);
  });

  it('a claim whose data dir entry cannot be checked is treated as in use, never released or expired', async () => {
    const dir = freshDir();
    const at = Math.floor(clock / 1000) - 7200;
    const token = signRoomToken({ roomId: ILL_FORMED, role: 'admin', secret: SECRET, now });
    const { jti, exp } = claimsOf(token);
    // Written by a build that accepted such ids; its token is still live.
    fs.writeFileSync(
      path.join(dir, 'access-control.json'),
      JSON.stringify({ claimedRooms: [ILL_FORMED], pendingClaims: { [ILL_FORMED]: { at, tokens: { [jti]: exp } } } }),
    );
    const ac = create(dir);
    expect(await ac.serverOptions.releaseEndpoint!.release(claimsOf(token))).toBe('in-use');
    clock += 8 * 24 * 3600_000; // past every token it recorded
    await ac.serverOptions.tokenEndpoint!.authorize(
      { roomId: 'sweep-trigger', role: 'admin' },
      { bearerClaims: null, clientIp: '192.0.2.9', mint: { jti: 'trigger', exp: Math.floor(clock / 1000) + 60 } },
    );
    await ac.flush();
    expect(stateOf(dir).claimedRooms).toContain(ILL_FORMED);
  });

  it('one such claim neither stops the server starting nor blocks every later state write', async () => {
    const dir = freshDir();
    const expired = Math.floor(clock / 1000) - 3600;
    fs.writeFileSync(
      path.join(dir, 'access-control.json'),
      JSON.stringify({
        claimedRooms: [ILL_FORMED, 'ordinary'],
        pendingClaims: {
          [ILL_FORMED]: { at: expired - 60, tokens: { bad: expired } },
          ordinary: { at: expired - 60, tokens: { ok: expired } },
        },
      }),
    );
    let ac: AccessControl | undefined;
    expect(() => {
      ac = create(dir);
    }, 'the server starts').not.toThrow();
    const base = await serve(ac!);
    const bystander = await mint(base, 'bystander');
    expect(await join(base, 'bystander', bystander.token!), 'an unrelated join still gets its confirmation written').toBe('admitted');
    await ac!.flush();
    const state = stateOf(dir);
    expect(state.claimedRooms, 'the ordinary expired claim was still swept').not.toContain('ordinary');
    expect(state.claimedRooms).toContain(ILL_FORMED);
    expect(() => create(dir), 'and the server starts again from what it wrote').not.toThrow();
  });
});
