# IFClite Autodesk service

A Node service for the viewer's hosted Autodesk connection. It owns APS OAuth tokens, proxies only fixed read operations, and streams signed model files without forwarding Autodesk credentials to storage.

## Run locally

Register an APS confidential application with callback `http://localhost:3000/api/autodesk/callback` for local development. Use your actual viewer port if different. Provision the app in the target account's Custom Integrations.

Set server-only environment variables using your local secret manager or untracked environment file:

```
AUTODESK_VIEWER_ORIGIN=http://localhost:3000
AUTODESK_CLIENT_ID=<registered application ID>
AUTODESK_CLIENT_SECRET=<server-only application secret>
AUTODESK_INSECURE_LOCALHOST=true
AUTODESK_SERVICE_PORT=3002
```

The service does not automatically read environment files. To use an untracked `apps/autodesk-service/.env.local`, start it after building with `node --env-file=apps/autodesk-service/.env.local apps/autodesk-service/dist/bin.js`. Copy the adjacent `.env.example` and replace the placeholder values locally.

Build from the repository root with `pnpm build`, then run `pnpm --filter @ifc-lite/autodesk-service start`. Build/start the viewer with `VITE_AUTODESK_HOSTED=true`. The viewer's Vite config proxies `/api/autodesk` to port 3002. Do not commit secrets or put them in `VITE_` variables.

## Hosted deployment

Reverse-proxy `/api/autodesk/*` on the viewer's exact HTTPS origin to this service. Register `https://your-viewer.example/api/autodesk/callback` with APS. Set the viewer's `VITE_AUTODESK_HOSTED=true`; keep `AUTODESK_INSECURE_LOCALHOST` unset. Exclude the service path from the SPA fallback. Vercel does not automatically deploy this process; use an explicitly configured gateway/reverse proxy. The service binds loopback by default; configure `AUTODESK_SERVICE_HOST` only behind your controlled gateway.

The cookie is opaque, host-only, HttpOnly, Secure and SameSite=Lax. Mutations require same-origin Origin plus a session CSRF value. OAuth transactions are single-use, expire after five minutes, and bind to the initiating session. Login rotates the session. Access/refresh tokens are held in process memory, never browser cookies/storage or disk. Refresh uses one manager per session. Tokens are refreshed with a sixteen-minute margin so a fifteen-minute native import can finish before its delegated access token expires.

**Deployment limitation:** the bundled store is bounded and single-process. Restart signs users out; multiple replicas are not supported without replacing the session store and refresh locking with a shared implementation. Sessions expire after eight hours or thirty minutes idle. Default capacity is 1,000 sessions and download limit is 512 MiB; configure the handler for different measured limits. This is not an automatically provisioned durable production service.

Downloads enforce the configured limit even without Content-Length. Only approved S3 download origins are allowed, with each redirect validated and no bearer header. A new Autodesk regional download host must be added deliberately with a test. Sign-out aborts session-owned transfers. Error responses never include raw upstream bodies, authorization codes, tokens or signed URLs.

## Conversion adapters

`createAutodeskHandler` accepts explicitly installed native artifact adapters. The adapter receives the delegated access token, exact qualified source reference, revision, region and abort signal server-side. It must return the same revision plus IFC for an exchange or IFCX for a proposal. The handler advertises only installed adapters and rejects unconfigured conversions.

Both adapters ship. Build the Forma converter with `cargo build --release -p ifc-lite-cloud-import` and set `AUTODESK_FORMA_CONVERTER` to its absolute executable path. Build/publish the [Windows SDK worker](../autodesk-exchange-worker/README.md) and set `AUTODESK_EXCHANGE_WORKER` to the executable on a Windows service host. For a Linux/Railway gateway, configure AUTODESK_EXCHANGE_WORKER_ORIGIN and AUTODESK_EXCHANGE_WORKER_KEY instead of the local executable, following the [remote Windows worker guide](../../deploy/autodesk/remote-exchange.md). Leave either adapter unconfigured to keep its resources unavailable. The default service bounds two jobs across conversion, retained artifacts and their downloads, rejecting excess work with a retryable busy response. POST /api/autodesk/import returns 202 with a session-owned job ID; GET /api/autodesk/imports/:id polls preparation; GET /api/autodesk/imports/:id/artifact claims a pinned artifact once; POST /api/autodesk/imports/:id/cancel cancels owned work with CSRF protection. Prepared results expire after two minutes and unfinished jobs/downloads after fifteen minutes. Short polling requests avoid edge-proxy inactivity limits.

Forma imports immutable element URNs and signed GLB blobs, applies glTF/element transforms in Rust, expands repeated occurrences, and carries projected placement into IFCX. Terrain supplied as a volume mesh uses this path. Source properties and representation metadata are retained. Textures, vertex colors and 2D terrain overlays are identified limitations; skins/morph targets and physical graph/extrusion representations without a volume mesh fail explicitly.

Data Exchange uses a fresh SDK process per import with its delegated token on stdin and caches/logs in a request scratch directory. Export supports the current Docs version, guarded by SDK snapshot and Docs-version checks before/after conversion. Sign-out/cancellation kills owned processes and removes scratch data. Historical exchange versions remain visible for reference with export disabled.

Run local tests through root `pnpm test --filter=@ifc-lite/autodesk-service`; root `pnpm typecheck` checks production and test sources.

## Verification without an APS account

Run root `pnpm test --filter=@ifc-lite/autodesk-service --filter=@ifc-lite/source-autodesk --filter=@ifc-lite/oauth-pkce --filter=@ifc-lite/plugin-api` and `pnpm typecheck`. The tests use a controlled upstream transport, with no real Autodesk credentials or Autodesk network calls; the remote worker contract also exercises an actual loopback Node HTTP server. They exercise the actual PKCE/session handler, authenticated API boundary, cancellation, historical revision ownership, regional routing, filtering and stream bounds. They cannot establish Autodesk account provisioning or current live service behavior. Build the Rust converter first; the service integration test then passes a real binary GLB fixture through the converter and the real IFCX parser. Set `TEST_FORMA_CONVERTER` to its absolute path and run root `pnpm test --env-mode=loose --filter=@ifc-lite/autodesk-service`. The Windows CI lane compiles the SDK worker and exercises offline snapshot/workspace guards.

Before enabling an account, verify sign-in/denial, popup blocking, cancellation while exchanging a code, refresh and idle expiry, account switching, US/EMEA access, a real IFC file and its historical version, denied and deleted files, large/cancelled transfers, and sign-out. Qualification of either native adapter additionally requires source-versus-import checks for geometry, units, coordinates, instances, terrain and properties.

## Production stack

[deploy/autodesk/compose.yml](../../deploy/autodesk/compose.yml) supplies a single-instance Linux service with the Forma converter and a Caddy HTTPS gateway serving the built viewer. Build the viewer with `VITE_AUTODESK_HOSTED=true`, configure an untracked service environment file from `.env.example`, set `IFCLITE_PUBLIC_HOST`, then run `docker compose -f deploy/autodesk/compose.yml up --build -d`. The gateway routes API requests before the SPA fallback and allows long imports. The service container runs as a non-root user, with scratch files in a bounded temporary filesystem.

For all three sources, run the Node service and both executables on Windows behind a same-origin HTTPS reverse proxy; the Linux image cannot host Autodesk's native Windows SDK. Register the exact public `/api/autodesk/callback` URL in APS. End users need Autodesk accounts and project/exchange permissions, but do not need to register their own APS apps. One deployment app registration is still required. No deployment or live authenticated Autodesk test is claimed by the local checks.

## Railway

Use [the Railway rollout](../../deploy/autodesk/railway.md) to add a separate Autodesk service to the existing rooms/sharing project. Keep one replica and sleep disabled. GET /healthz reports startup/importer configuration without allocating a session or calling APS. The process honors Railway PORT unless AUTODESK_SERVICE_PORT is explicitly set. The Linux image supports Docs and Forma locally, plus Data Exchange through the authenticated remote Windows worker. The native SDK still requires Windows.

The gateway and worker abort owned jobs/native process trees on SIGTERM/SIGINT before closing HTTP connections, with a five-second exit deadline. Dockerfile-specific ignore rules exclude local secrets and build artifacts from the service build context.
