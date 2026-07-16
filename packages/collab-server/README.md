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
| `COLLAB_PORT` | `1234` | Listen port |
| `COLLAB_HOST` | `0.0.0.0` | Listen host |
| `COLLAB_DATA_DIR` | `./.collab-data` | Persistence root for room logs, blobs, and the layer registry |
| `COLLAB_MAX_ROOMS` | `1024` | Soft cap on simultaneous rooms |
| `COLLAB_LAYER_REGISTRY` | off | `1`/`true` mounts the layer registry (`/api/v1/layers\|refs\|reviews`), disk-backed under `COLLAB_DATA_DIR/layer-registry` |
| `COLLAB_REGISTRY_WEBHOOK_URL` | off | POST registry events (layer pushed, ref moved/merged, review opened/updated/commented) to this URL |
| `COLLAB_REGISTRY_WEBHOOK_SECRET` | none | HMAC-SHA256 signing secret for webhook payloads (`x-ifclite-signature`) |

## Programmatic use

```ts
import { startCollabServer } from '@ifc-lite/collab-server';

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
`FilePersistence`, `RoomManager`, audit sinks, and retention helpers.

## Docs

See the [ifc-lite docs](https://ifclite.dev/docs/).

## License

MPL-2.0
