/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Registry auth in room-token deployments: room tokens bind to ONE room,
 * so the default authenticate-adapter (pseudo-room `__layer_registry__`)
 * can never admit them — the registry would be locked out entirely in a
 * token-secured deployment. `createRoomTokenRegistryAuthorizer` verifies
 * the token without the room binding (blob-route pattern), keeps the
 * revocation deny-list biting, and gates writes on editor/admin.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRoomTokenAuthenticator,
  createRoomTokenRegistryAuthorizer,
  signRoomToken,
  startCollabServer,
  type CollabServerHandle,
} from '../src/index.js';

const SECRET = 'registry-room-token-secret';

function mint(role: 'viewer' | 'editor' | 'admin'): string {
  return signRoomToken({ secret: SECRET, roomId: 'room-1', role, ttlSeconds: 600 });
}

describe('registry auth with room tokens', () => {
  const revoked = new Set<string>();
  let handle: CollabServerHandle;
  let lockedOut: CollabServerHandle;
  let api: string;
  let lockedApi: string;

  beforeAll(async () => {
    handle = await startCollabServer({
      port: 0,
      layerRegistry: true,
      authenticate: createRoomTokenAuthenticator({ secret: SECRET, isRevoked: (jti) => revoked.has(jti) }),
      authorizeRegistry: createRoomTokenRegistryAuthorizer({
        secret: SECRET,
        isRevoked: (jti) => revoked.has(jti),
      }),
    });
    api = `http://127.0.0.1:${(handle.httpServer.address() as { port: number }).port}/api/v1`;

    // The regression this guards against: the same deployment WITHOUT the
    // dedicated authorizer rejects every real room token.
    lockedOut = await startCollabServer({
      port: 0,
      layerRegistry: true,
      authenticate: createRoomTokenAuthenticator({ secret: SECRET }),
    });
    lockedApi = `http://127.0.0.1:${(lockedOut.httpServer.address() as { port: number }).port}/api/v1`;
  });

  afterAll(async () => {
    await handle.stop();
    await lockedOut.stop();
  });

  const as = (api2: string, token: string | null, path: string, init?: RequestInit) =>
    fetch(`${api2}${path}`, {
      ...init,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it('admits room tokens without the room binding; the default adapter locks them out', async () => {
    const viewer = mint('viewer');
    expect((await as(api, viewer, '/layers')).status).toBe(200);
    // Same token against the default-adapter deployment: 401 (the bug).
    expect((await as(lockedApi, viewer, '/layers')).status).toBe(401);
    // No token at all is still refused when an authorizer is present.
    expect((await as(api, null, '/layers')).status).toBe(401);
  });

  it('gates writes on editor/admin and honors revocation', async () => {
    const viewer = mint('viewer');
    const editor = mint('editor');
    expect(
      (await as(api, viewer, '/refs/main', { method: 'PUT', body: JSON.stringify({ layers: [] }) })).status
    ).toBe(401);
    expect(
      (await as(api, editor, '/refs/main', { method: 'PUT', body: JSON.stringify({ layers: [] }) })).status
    ).toBe(201);
    // Revoke the editor link: reads and writes both die with it.
    const { verifyRoomToken } = await import('../src/room-token.js');
    const claims = verifyRoomToken(editor, { secret: SECRET });
    revoked.add(claims!.jti);
    expect((await as(api, editor, '/layers')).status).toBe(401);
  });
});
