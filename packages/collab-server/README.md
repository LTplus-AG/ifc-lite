# @ifc-lite/collab-server

Reference websocket sync server for [`@ifc-lite/collab`](../collab).

> **Status: v0.2 scaffold.** y-websocket-compatible sync, in-memory room
> registry, append-only file persistence, JWT auth hook, healthcheck.
> Production hardening (auth roles, S3 persistence, observability) lands
> in v0.5 per `docs/architecture/collab-plan.md`.

## Run it

```sh
pnpm --filter @ifc-lite/collab-server build
pnpm --filter @ifc-lite/collab-server start
# default port 1234, persistence at ./.collab-data/
```

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `COLLAB_PORT` | `1234` | Listen port |
| `COLLAB_HOST` | `0.0.0.0` | Listen host |
| `COLLAB_DATA_DIR` | `./.collab-data` | Persistence root for room logs |
| `COLLAB_JWT_SECRET` | _(unset = auth disabled)_ | HMAC secret for JWT validation |
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

## License

MPL-2.0
