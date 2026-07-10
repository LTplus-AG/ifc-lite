/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { startCollabServer, type CollabServerHandle } from '../src/server.js';
import { createRoomTokenAuthenticator, type Role } from '../src/room-token.js';
import { MemoryPersistence } from '../src/persistence.js';

const SECRET = 'test-secret-key';

let handle: CollabServerHandle | null = null;
const revoked = new Set<string>();
const claimed = new Set<string>();

afterEach(async () => {
  await handle?.stop();
  handle = null;
  revoked.clear();
  claimed.clear();
});

/** Mirrors the bin's accountless first-touch-creator policy. */
async function start() {
  handle = await startCollabServer({
    port: 0,
    persistence: new MemoryPersistence(),
    authenticate: createRoomTokenAuthenticator({ secret: SECRET, isRevoked: (j) => revoked.has(j) }),
    tokenEndpoint: {
      secret: SECRET,
      authorize: (request, { bearerClaims }): Role | null => {
        const room = request.roomId;
        if (bearerClaims?.room === room && bearerClaims.role === 'admin') return request.role;
        if (!claimed.has(room)) {
          claimed.add(room);
          return 'admin';
        }
        return null;
      },
    },
    revokeEndpoint: {
      secret: SECRET,
      recordRevocation: (j) => {
        revoked.add(j);
      },
    },
    kickEndpoint: { secret: SECRET },
  });
  const { port } = handle.httpServer.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

const mint = (base: string, body: object, bearer?: string) =>
  fetch(`${base}/collab/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });

describe('room-token auth + revoke (bin policy)', () => {
  it('first-touch creator → admin; admin mints role links; non-admin denied; revoke blocks join', async () => {
    const base = await start();

    // 1. First mint for a fresh room → creator becomes admin.
    const adminRes = await mint(base, { roomId: 'roomA', role: 'admin' });
    expect(adminRes.status).toBe(200);
    const admin = (await adminRes.json()) as { token: string; role: Role };
    expect(admin.role).toBe('admin');

    // 2. Admin bearer may mint a role-scoped (editor) link.
    const editorRes = await mint(base, { roomId: 'roomA', role: 'editor' }, admin.token);
    expect(editorRes.status).toBe(200);
    const editor = (await editorRes.json()) as { token: string; role: Role };
    expect(editor.role).toBe('editor');

    // 3. A non-admin (no bearer) cannot mint once the room is claimed.
    const deniedRes = await mint(base, { roomId: 'roomA', role: 'editor' });
    expect(deniedRes.status).toBe(403);
    await deniedRes.body?.cancel();

    // 4. The editor token authenticates a join…
    const authFn = createRoomTokenAuthenticator({ secret: SECRET, isRevoked: (j) => revoked.has(j) });
    expect(await authFn(editor.token, 'roomA')).not.toBeNull();
    expect(await authFn(undefined, 'roomA')).toBeNull(); // no token → rejected

    // 5. …until an admin revokes it.
    const revRes = await fetch(`${base}/collab/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ token: editor.token }),
    });
    expect(revRes.status).toBe(200);
    expect(await authFn(editor.token, 'roomA')).toBeNull();
  });

  it('revoke requires an admin bearer for the same room', async () => {
    const base = await start();
    const admin = (await (await mint(base, { roomId: 'roomB', role: 'admin' })).json()) as { token: string };
    const editor = (await (await mint(base, { roomId: 'roomB', role: 'editor' }, admin.token)).json()) as {
      token: string;
    };
    // A non-admin (editor) bearer cannot revoke.
    const res = await fetch(`${base}/collab/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${editor.token}` },
      body: JSON.stringify({ token: editor.token }),
    });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });

  it('kick requires an admin bearer; reports whether a peer matched', async () => {
    const base = await start();
    const admin = (await (await mint(base, { roomId: 'roomC', role: 'admin' })).json()) as { token: string };
    const editor = (await (await mint(base, { roomId: 'roomC', role: 'editor' }, admin.token)).json()) as {
      token: string;
    };
    // Non-admin cannot kick.
    const denied = await fetch(`${base}/collab/kick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${editor.token}` },
      body: JSON.stringify({ roomId: 'roomC', clientId: 1 }),
    });
    expect(denied.status).toBe(403);
    await denied.body?.cancel();
    // Admin kick is accepted; no peer with that clientId is connected → kicked:false.
    const ok = await fetch(`${base}/collab/kick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ roomId: 'roomC', clientId: 999 }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { kicked: boolean }).kicked).toBe(false);
  });
});
