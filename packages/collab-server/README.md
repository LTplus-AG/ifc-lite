# @ifc-lite/collab-server

Reference websocket sync server for [`@ifc-lite/collab`](https://www.npmjs.com/package/@ifc-lite/collab).

> **Status: early (0.x).** y-websocket-compatible sync, room manager,
> pluggable auth hook (viewer / commenter / editor / admin roles), file,
> S3 and Redis persistence, audit log, rate limiting, retention policies,
> metrics endpoint, blob route, and healthcheck.

## Run it

```sh
npx @ifc-lite/collab-server
# default port 1234
```

Or install it:

```sh
npm install @ifc-lite/collab-server
npx ifc-lite-collab-server
```

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `COLLAB_PORT` | `PORT`, else `1234` | Listen port (falls back to the host-injected `PORT`) |
| `COLLAB_HOST` | `0.0.0.0` | Listen host |
| `COLLAB_DATA_DIR` | `./.collab-data` | Persistence root for room logs, blobs, and the layer registry |
| `COLLAB_MAX_ROOMS` | `1024` | Hard cap on loaded rooms; a new room past it is refused |
| `COLLAB_IDLE_UNLOAD_MS` | `300000` (5 min) | Unload rooms with no peers for this long; `0` disables |
| `COLLAB_TOKEN_SECRET` | unset | Enables signed room-token access control. Unset, the server is open (anonymous editor) and warns at startup |
| `COLLAB_MAX_CLAIMED_ROOMS` | `100000` | Cap on room claims (only with `COLLAB_TOKEN_SECRET`) |
| `COLLAB_TRUST_PROXY` | off | `1`/`true` honours `X-Forwarded-For` for token-mint rate limiting; set only behind a trusted reverse proxy |
| `COLLAB_METRICS_TOKEN` | unset | Bearer token required for `/metrics` and for the room count in `/healthz`; unset leaves them open |
| `COLLAB_BLOB_GC` | on | `0`/`false` disables the periodic sweep of unreferenced geometry blobs |
| `COLLAB_BLOB_GC_INTERVAL_MS` | `21600000` (6 h) | Blob sweep interval |
| `COLLAB_BLOB_GC_GRACE_MS` | `86400000` (24 h) | Minimum age before an unreferenced blob is deleted (at least `60000`) |
| `COLLAB_LAYER_REGISTRY` | off | `1`/`true` mounts the layer registry (`/api/v1/layers\|refs\|reviews`), disk-backed under `COLLAB_DATA_DIR/layer-registry` |
| `COLLAB_REGISTRY_WEBHOOK_URL` | off | POST registry events (layer pushed, ref moved/merged, review opened/updated/commented) to this URL |
| `COLLAB_REGISTRY_WEBHOOK_SECRET` | none | HMAC-SHA256 signing secret for webhook payloads (`x-ifclite-signature`) |

## Programmatic use

```ts
import { startCollabServer } from '@ifc-lite/collab-server';

// Your own credential check — a JWT verify, a session lookup, whatever you
// already run. (`createRoomTokenAuthenticator` ships one if you want ours.)
declare function verify(token: string | undefined): boolean;

const server = await startCollabServer({
  port: 4444,
  authenticate: async (token, room) => {
    if (!verify(token)) return null;
    return { userId: 'louis', role: 'editor' };
  },
});

// Later:
await server.stop();
```

Also exported: `S3Persistence`, `RedisPersistence`, `MemoryPersistence`,
`FilePersistence`, `RoomManager`, audit sinks, and retention helpers, plus
`createAccessControl` (the signed room-token access control the CLI enables
with `COLLAB_TOKEN_SECRET`), the layer registry (`MemoryLayerRegistry`,
`FsLayerRegistry`), blob storage and garbage collection (`FsBlobStorage`,
`InMemoryBlobStorage`, `BlobGcWorker`) and `startSecureCollabServer` for TLS.
Room tokens (`signRoomToken`, `verifyRoomToken`, `createRoomTokenAuthenticator`),
path locks (`createPathLockRegistry`), signed-frame replay protection
(`createReplayProtector`) and `SnapshotWorker` (server-side IFCX snapshots)
are exported too.
`@ifc-lite/collab-server/room-manager` exports `RoomManager` and `Room` on
their own. See the [collaboration server guide](https://ifclite.dev/docs/guide/collab-server/).

## Docs

See the [ifc-lite docs](https://ifclite.dev/docs/).

## License

MPL-2.0
