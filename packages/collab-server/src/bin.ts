#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CLI entry point: `ifc-lite-collab-server`. */

import { FilePersistence, startCollabServer } from './server.js';
import { FsBlobStorage } from './blob-route.js';
import { FsLayerRegistry } from './layer-registry-fs.js';
import { createAccessControl } from './access-control.js';

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
  // Accountless room access control (see access-control.ts): joins require a
  // signed room token; a fresh room's first mint makes its requester admin;
  // admins can revoke links by `jti`.
  const accessControl = tokenSecret
    ? createAccessControl({
        secret: tokenSecret,
        dir: dataDir,
        maxClaimedRooms: Number(process.env.COLLAB_MAX_CLAIMED_ROOMS ?? 100_000),
        // Only honor X-Forwarded-For behind a trusted reverse proxy; a directly
        // reachable server that trusts the header lets every mint request pick
        // a fresh spoofed IP (its own rate-limit bucket). Default OFF.
        trustForwardedFor: ['1', 'true'].includes(
          (process.env.COLLAB_TRUST_PROXY ?? '').toLowerCase(),
        ),
      })
    : null;
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
    ...(accessControl ? accessControl.serverOptions : {}),
  });
  // eslint-disable-next-line no-console
  console.log(
    `[collab-server] listening at ${handle.url} (data: ${dataDir}, auth: ${tokenSecret ? 'room-token' : 'anonymous'}, registry: ${layerRegistryEnabled ? 'fs' : 'off'})`,
  );

  const shutdown = async () => {
    // eslint-disable-next-line no-console
    console.log('[collab-server] shutting down…');
    await handle.stop();
    // A SIGTERM during the persist debounce (or mid-write) must not lose
    // claims/revocations: await the pending/in-flight state write. flush()
    // rejects when the state never reached disk — exit non-zero and say so
    // loudly rather than pretend the shutdown was durable.
    if (accessControl) {
      try {
        await accessControl.flush();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          '[collab-server] FAILED to persist access-control state on shutdown; claims/revocations since the last successful write are LOST:',
          err,
        );
        process.exit(1);
      }
    }
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
