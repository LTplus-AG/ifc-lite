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
| `COLLAB_DATA_DIR` | `./.collab-data` | Persistence root for room logs |
| `COLLAB_MAX_ROOMS` | `1024` | Soft cap on simultaneous rooms |

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
