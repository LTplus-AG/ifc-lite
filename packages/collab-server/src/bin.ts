#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CLI entry point: `ifc-lite-collab-server`. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FilePersistence, startCollabServer, type StartCollabServerOptions } from './server.js';
import { FsBlobStorage } from './blob-route.js';
import { FsLayerRegistry } from './layer-registry-fs.js';
import { createRoomTokenAuthenticator, createRoomTokenRegistryAuthorizer, verifyRoomToken } from './room-token.js';
import { type Role } from './auth.js';

// `PORT` is the convention most hosts inject (Railway, Render, Fly, …).
const port = Number(process.env.COLLAB_PORT ?? process.env.PORT ?? 1234);
const host = process.env.COLLAB_HOST ?? '0.0.0.0';
const dataDir = process.env.COLLAB_DATA_DIR ?? './.collab-data';
const maxRooms = Number(process.env.COLLAB_MAX_ROOMS ?? 1024);
// Link-based access control is enabled by setting a signing secret. Without it
// the server stays open (anonymous editor) — fine for local/dev, see auth.ts.
const tokenSecret = process.env.COLLAB_TOKEN_SECRET;
// Layer registry (10-registry.md) is opt-in; when enabled it persists to the
// same data dir as rooms and blobs, so a mounted volume covers all three.
const layerRegistryEnabled = ['1', 'true'].includes(
  (process.env.COLLAB_LAYER_REGISTRY ?? '').toLowerCase(),
);
// One notification consumer via env (08-review.md §8.7); programmatic
// deployments pass a full webhook list through startCollabServer instead.
const registryWebhookUrl = process.env.COLLAB_REGISTRY_WEBHOOK_URL;
const registryWebhooks = registryWebhookUrl
  ? [
      {
        url: registryWebhookUrl,
        ...(process.env.COLLAB_REGISTRY_WEBHOOK_SECRET
          ? { secret: process.env.COLLAB_REGISTRY_WEBHOOK_SECRET }
          : {}),
      },
    ]
  : [];

/**
 * Accountless room access control:
 *   - Joins require a valid signed room token (role is tamper-proof + revocable).
 *   - The *first* token minted for a brand-new room makes its requester admin
 *     (room creation / first-touch). Afterwards only an admin token for that
 *     room may mint further links — so a link's holder can't escalate.
 *   - Admins can revoke a link by `jti` (deny-list).
 */
function tokenOptions(secret: string, dir: string): Partial<StartCollabServerOptions> {
  // Persist the revocation deny-list + claimed-room set to disk so they survive
  // restarts. Without this, a restart (a) forgets revocations and (b) lets the
  // first POST /collab/token for an already-claimed persisted room take it over
  // with a fresh admin token. (Needs a durable volume to actually persist.)
  const statePath = path.join(dir, 'access-control.json');
  const revoked = new Set<string>();
  const claimedRooms = new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      revoked?: string[];
      claimedRooms?: string[];
    };
    for (const j of parsed.revoked ?? []) revoked.add(j);
    for (const r of parsed.claimedRooms ?? []) claimedRooms.add(r);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn('[collab-server] could not read access-control state:', err);
    }
  }
  const persist = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({ revoked: [...revoked], claimedRooms: [...claimedRooms] }),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[collab-server] could not persist access-control state:', err);
    }
  };
  return {
    authenticate: createRoomTokenAuthenticator({ secret, isRevoked: (jti) => revoked.has(jti) }),
    // Blobs are content-addressed and NOT room-scoped, but the default blob
    // authorizer reuses the WS `authenticate` with a pseudo-room scope — which
    // a room-bound token can never match. Verify signature/expiry/revocation
    // without the room binding instead; writes additionally need editor/admin.
    // The registry is project-scoped like blobs: verify the token without
    // its room binding (see createRoomTokenRegistryAuthorizer) — otherwise
    // room tokens can never reach /api/v1 and the registry is locked out.
    authorizeRegistry: createRoomTokenRegistryAuthorizer({
      secret,
      isRevoked: (jti) => revoked.has(jti),
    }),
    authorizeBlob: (token, method) => {
      const claims = verifyRoomToken(token ?? '', { secret });
      if (!claims || revoked.has(claims.jti)) return false;
      if (method === 'PUT' || method === 'DELETE') {
        return claims.role === 'editor' || claims.role === 'admin';
      }
      return true;
    },
    tokenEndpoint: {
      secret,
      // A revoked bearer (e.g. a kicked admin) is treated as absent before the
      // authorize policy even runs; the policy's own check below is defense in
      // depth for custom deployments that omit `isRevoked`.
      isRevoked: (jti) => revoked.has(jti),
      authorize: (request, { bearerClaims }): Role | null => {
        const room = request.roomId;
        // A revoked bearer must not be able to keep minting links, even though
        // its signature + expiry still verify.
        if (bearerClaims?.jti && revoked.has(bearerClaims.jti)) return null;
        if (bearerClaims?.room === room && bearerClaims.role === 'admin') return request.role;
        if (!claimedRooms.has(room)) {
          claimedRooms.add(room);
          persist();
          return 'admin'; // creator of a fresh room
        }
        return null; // claimed room + non-admin caller → denied
      },
    },
    revokeEndpoint: {
      secret,
      isRevoked: (jti) => revoked.has(jti),
      recordRevocation: (jti) => {
        revoked.add(jti);
        persist();
      },
    },
    kickEndpoint: { secret, isRevoked: (jti) => revoked.has(jti) },
  };
}

async function main() {
  const handle = await startCollabServer({
    port,
    host,
    persistence: new FilePersistence({ dataDir }),
    // Disk-backed blobs (not the in-RAM default): mesh blobs dominate a room's
    // size, so keeping them in memory made memory the top hosting cost and lost
    // them on restart. On a mounted volume this is durable and far cheaper.
    blobStorage: new FsBlobStorage(dataDir),
    maxRooms,
    ...(layerRegistryEnabled
      ? { layerRegistry: { store: new FsLayerRegistry(dataDir), webhooks: registryWebhooks } }
      : {}),
    ...(tokenSecret ? tokenOptions(tokenSecret, dataDir) : {}),
  });
  // eslint-disable-next-line no-console
  console.log(
    `[collab-server] listening at ${handle.url} (data: ${dataDir}, auth: ${tokenSecret ? 'room-token' : 'anonymous'}, registry: ${layerRegistryEnabled ? 'fs' : 'off'})`,
  );

  const shutdown = async () => {
    // eslint-disable-next-line no-console
    console.log('[collab-server] shutting down…');
    await handle.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[collab-server] fatal:', err);
  process.exit(1);
});
