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
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import { type Role } from './auth.js';

// `PORT` is the convention most hosts inject (Railway, Render, Fly, …).
const port = Number(process.env.COLLAB_PORT ?? process.env.PORT ?? 1234);
const host = process.env.COLLAB_HOST ?? '0.0.0.0';
const dataDir = process.env.COLLAB_DATA_DIR ?? './.collab-data';
const maxRooms = Number(process.env.COLLAB_MAX_ROOMS ?? 1024);
// Idle rooms are loaded on connect and otherwise never evicted until the
// `maxRooms` ceiling is hit — after which *every* new connection fails. Unload
// rooms that have had zero peers for this long so long-lived deployments don't
// silently wedge. The persistence layer keeps the durable copy, so an unloaded
// room reloads transparently on the next connect. Default: 5 minutes.
const idleUnloadMs = Number(process.env.COLLAB_IDLE_UNLOAD_MS ?? 5 * 60 * 1000);
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
  // Persistence used to be a synchronous full-file `writeFileSync` on *every*
  // claim/revocation — a cheap way for an attacker looping mint calls to pin
  // the event loop on disk I/O. Coalesce writes behind a short debounce and an
  // in-flight guard so a burst of claims collapses to a single async write.
  const PERSIST_DEBOUNCE_MS = 250;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let writing = false;
  let dirty = false;
  const flush = async () => {
    if (writing) {
      dirty = true;
      return;
    }
    writing = true;
    dirty = false;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        statePath,
        JSON.stringify({ revoked: [...revoked], claimedRooms: [...claimedRooms] }),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[collab-server] could not persist access-control state:', err);
    } finally {
      writing = false;
      // A claim/revocation that landed while the write was in flight left the
      // snapshot stale — schedule one more pass to capture it.
      if (dirty) void flush();
    }
  };
  const persist = () => {
    dirty = true;
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void flush();
    }, PERSIST_DEBOUNCE_MS);
    // Don't keep the event loop alive solely for a pending persist.
    writeTimer.unref?.();
  };

  // Bound `claimedRooms` growth. Each fresh-room first-claim adds an entry that
  // persists forever; without a ceiling an attacker (or a very long-lived
  // deployment) grows the set — and every serialized write — without limit.
  // Legitimate multi-room deployments stay well under the default 100k cap.
  const maxClaimedRooms = Number(process.env.COLLAB_MAX_CLAIMED_ROOMS ?? 100_000);

  // Per-IP rate limiter for the unauthenticated mint path. A fresh room's first
  // mint needs no bearer, so without this an attacker can loop `POST
  // /collab/token` to mint admin tokens (and grow `claimedRooms`) for free.
  // Generous burst so legitimate admins minting several links never trip it.
  const MINT_RATE_CAPACITY = 30;
  const MINT_RATE_REFILL_PER_SEC = 0.5; // ~30 mints/min sustained per IP
  const MAX_RATE_LIMITERS = 4096; // bound the per-IP map so it isn't its own DoS
  const mintLimiters = new Map<string, RateLimiter>();
  const mintRateAllows = (clientIp: string | undefined): boolean => {
    const key = clientIp && clientIp.length > 0 ? clientIp : 'unknown';
    let limiter = mintLimiters.get(key);
    if (!limiter) {
      if (mintLimiters.size >= MAX_RATE_LIMITERS) {
        // Coarse eviction: drop the oldest-inserted entries so a spray of
        // spoofed source IPs can't grow the map unboundedly.
        const evict = Math.ceil(MAX_RATE_LIMITERS / 8);
        let n = 0;
        for (const k of mintLimiters.keys()) {
          mintLimiters.delete(k);
          if (++n >= evict) break;
        }
      }
      limiter = createRateLimiter({
        capacity: MINT_RATE_CAPACITY,
        refillPerSecond: MINT_RATE_REFILL_PER_SEC,
      });
      mintLimiters.set(key, limiter);
    }
    return limiter.tryConsume(1);
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
      // DESIGN NOTE (flagged, deliberate): blobs are global and
      // content-addressed, so this check drops the room binding — any valid
      // editor/admin token may PUT/DELETE any blob hash regardless of which
      // room it belongs to. In a multi-tenant deployment that means a DELETE
      // from tenant A can remove a content-identical blob referenced by tenant
      // B (and a PUT could pre-seed one). This is accepted as part of the
      // content-addressed model (identical bytes are one object); if per-tenant
      // blob isolation is ever required, blobs must be namespaced/reference-
      // counted per room instead of relaxing the room binding here.
      return true;
    },
    tokenEndpoint: {
      secret,
      // A revoked bearer (e.g. a kicked admin) is treated as absent before the
      // authorize policy even runs; the policy's own check below is defense in
      // depth for custom deployments that omit `isRevoked`.
      isRevoked: (jti) => revoked.has(jti),
      authorize: (request, { bearerClaims, clientIp }): Role | null => {
        const room = request.roomId;
        // A revoked bearer must not be able to keep minting links, even though
        // its signature + expiry still verify.
        if (bearerClaims?.jti && revoked.has(bearerClaims.jti)) return null;
        // An admin token for this room can re-mint links without tripping the
        // per-IP budget — the throttle targets the unauthenticated fresh-room
        // path an attacker abuses, not authenticated re-mints.
        if (bearerClaims?.room === room && bearerClaims.role === 'admin') return request.role;
        // Everything below is the unauthenticated "first claim of a fresh room
        // becomes admin" path: rate-limit it per IP so it can't be looped.
        if (!mintRateAllows(clientIp)) return null;
        if (!claimedRooms.has(room)) {
          if (claimedRooms.size >= maxClaimedRooms) {
            // eslint-disable-next-line no-console
            console.warn(
              `[collab-server] claimedRooms cap (${maxClaimedRooms}) reached; refusing new fresh-room claim`,
            );
            return null;
          }
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
  if (!tokenSecret) {
    const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    // Without a signing secret the server runs fully open (anonymous editor):
    // anyone who can reach it can read and edit every room. Fine bound to
    // loopback for local/dev, dangerous on a public interface — make the latter
    // impossible to miss in logs.
    // eslint-disable-next-line no-console
    console.warn(
      loopback
        ? '[collab-server] WARNING: no COLLAB_TOKEN_SECRET set — running OPEN (anonymous editor, no access control). OK for local/dev only.'
        : `[collab-server] WARNING: no COLLAB_TOKEN_SECRET set and bound to a non-loopback host (${host}) — the server is OPEN to anyone who can reach it. Set COLLAB_TOKEN_SECRET before exposing it.`,
    );
  }
  const handle = await startCollabServer({
    port,
    host,
    persistence: new FilePersistence({ dataDir }),
    // Disk-backed blobs (not the in-RAM default): mesh blobs dominate a room's
    // size, so keeping them in memory made memory the top hosting cost and lost
    // them on restart. On a mounted volume this is durable and far cheaper.
    blobStorage: new FsBlobStorage(dataDir),
    maxRooms,
    // Evict idle rooms so a long-lived server doesn't accumulate loaded rooms
    // up to `maxRooms` and then reject all new connections (see const above).
    ...(idleUnloadMs > 0 ? { idleUnloadMs } : {}),
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
