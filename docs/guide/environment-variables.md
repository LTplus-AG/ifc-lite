# Environment Variables

This page lists the environment variables that IFClite code reads and that no feature guide describes. Variables that a guide already covers are listed at the end, with a link to that guide.

`VITE_*` variables are read when the viewer is built. Vite compiles their values into the browser bundle, so never put a secret in one. All other variables are read at run time by a server, a CLI or a Rust process.

## Viewer build (`VITE_*`)

| Variable | Default | Effect |
|---|---|---|
| `VITE_LLM_PROXY_URL` | `/api/chat` | Proxy endpoint the viewer's AI features send free-model requests to (assistant, workflow creation, table suggestions, clash classification). |
| `VITE_LLM_FREE_MODELS` | none | Comma-separated model ids offered as free models through the proxy. Without it no free model is configured, and users add their own API key in Settings. |
| `VITE_LLM_IMAGE_MODELS` | none | Comma-separated free-model ids that accept images. Without it, free models accept no images. |
| `VITE_LLM_FILE_ATTACHMENT_MODELS` | none | Comma-separated free-model ids that accept file attachments. Without it, every free model accepts them. |
| `VITE_SOURCE_BIMCOLLAB` | on | `false` removes the BIMcollab Documents source, for a deployment without the `/api/bimcollab` relay. |
| `VITE_CESIUM_ION_TOKEN` | none | Default Cesium ion token for the 3D Tiles context overlay. A token the user enters in the viewer overrides it. |
| `VITE_SERVER_URL` | none | Older name for `VITE_IFC_SERVER_URL`. Used only when `VITE_IFC_SERVER_URL` is not set. |
| `VITE_BCF_APP_<PRESET>_CLIENT_ID` | none | OAuth client id the deployment registered with a BCF server vendor. |
| `VITE_BCF_APP_<PRESET>_REDIRECT_URI` | `<viewer origin>/oauth/bcf/callback` | Only when the vendor registered a different redirect URI. |
| `VITE_SOURCEMAP` | off | `1` makes `vite build` emit production source maps. On Vercel the build script decides this itself and ignores an inherited value (see below). |
| `VITE_BUNDLE_ANALYSIS` | off | `1` makes `vite build` write `bundle-analysis.json` (chunk and module sizes) into the output. |

The two capability lists apply only to free models; models used with your own API key have fixed capabilities. Outside the browser (in Node, for tests), the model list also falls back to the unprefixed `LLM_FREE_MODELS`, `LLM_IMAGE_MODELS` and `LLM_FILE_ATTACHMENT_MODELS`.

`VITE_SOURCEMAP` and `VITE_BUNDLE_ANALYSIS` are read from the shell environment of the build, not from a `.env` file.

`<PRESET>` is one of `ACONEX_AMERICAS`, `ACONEX_ASIA`, `ACONEX_AUNZ`, `ACONEX_EUROPE`, `ACONEX_HONGKONG`, `ACONEX_CHINA`, `ACONEX_SAUDI`, `ACONEX_UK`, `BIMCOLLAB`, `BIMDATA`, `BIMTRACK`, `CATENDA`, `DALUX`, `OPENPROJECT` or `STREAMBIM`. The buildagil preset uses `VITE_BUILDAGIL_CLIENT_ID` instead. [BCF Collaboration](./bcf.md#viewer-integration) describes the BIMcollab case and its token relay.

### Vercel build script

`scripts/vercel-build.sh` builds the viewer on Vercel. Set these in the Vercel project environment:

| Variable | Default | Effect |
|---|---|---|
| `POSTHOG_CLI_API_KEY`, `POSTHOG_CLI_ENV_ID` | none | With both set, the build makes source maps, uploads them to PostHog with `posthog-cli` and deletes them from the output. Only on a builder with at least 12 GB of RAM. `POSTHOG_CLI_HOST` sets the PostHog host for `posthog-cli`. |
| `VERCEL_SOURCEMAPS` | none | `1` forces source maps on, `0` forces them off, whatever the keys and RAM. |
| `VERCEL_NODE_MAX_OLD_SPACE_MB` | `5120`, less on a builder under 7 GB | Node heap cap for the bundle step. A larger `--max-old-space-size` already in `NODE_OPTIONS` is replaced. |
| `TURBO_TOKEN`, `TURBO_TEAM` | none | With both set, the build uses the Turborepo remote cache. |

## Viewer deployment functions

The viewer deployment ships serverless functions under `api/` at the repository root. Their server-only variables are:

### Free-model chat proxy (`/api/chat`)

The proxy forwards free-model requests to an OpenAI-compatible endpoint and counts each anonymous user's daily requests in a Postgres database (Neon). It refuses any model that is not in `LLM_FREE_MODELS`.

| Variable | Required | Effect |
|---|---|---|
| `LLM_API_BASE` | yes | Base URL of the upstream API. The proxy posts to `<base>/chat/completions`. |
| `LLM_API_KEY` | yes | API key for that endpoint. |
| `LLM_FREE_MODELS` | yes | Comma-separated model ids the proxy accepts. Keep it in step with `VITE_LLM_FREE_MODELS`. |
| `LLM_FREE_DAILY_LIMIT` | yes | Free requests per user per day. Over the limit the proxy answers `429`. |
| `APP_URL` | yes | The viewer's origin. Requests from it are allowed. |
| `APP_ALLOWED_ORIGINS` | no | Further allowed origins, comma-separated. |
| `DATABASE_URL` | yes | Postgres connection string. The proxy creates its `llm_chat_usage` table when it is missing. |
| `LLM_DEBUG_CREDITS` | no | `1` logs usage accounting events. They are also logged whenever `NODE_ENV` is not `production`. |

### Dalux relay (`/api/dalux`)

| Variable | Default | Effect |
|---|---|---|
| `DALUX_RELAY_ALLOWED_ORIGINS` | `APP_URL` | Comma-separated origins allowed to call the relay. |

The other relays are documented with their sources: the BIMcollab relay (`BIMCOLLAB_RELAY_ALLOWED_ORIGINS`) in the [Dalux package README](https://github.com/LTplus-AG/ifc-lite/blob/main/packages/source-dalux/README.md), the buildagil relay (`BUILDAGIL_*`) in the [buildagil package README](https://github.com/LTplus-AG/ifc-lite/blob/main/packages/source-buildagil/README.md), and the BCF token relay (`BCF_*`) in [BCF Collaboration](./bcf.md).

## CLI and MCP server

| Variable | Effect |
|---|---|
| `DEBUG` | Any value prints the stack trace when `ifc-lite` or `ifc-lite-mcp` exits on an error. `ifc-lite --debug` does the same. |
| `IFC_DEBUG` | `true` turns on the info and debug logs of the parser and data packages in Node. In a browser, set `localStorage.IFC_DEBUG = 'true'` instead. |
| `IFC_LITE_REGISTRY_TOKEN` | Bearer token for `ifc-lite layer push` when `--token` is not given. |
| `USER`, `USERNAME` | Author recorded by `ifc-lite layer publish`, `merge`, `revert` and `rebase` when `--principal` is not given (for `rebase`, only when the candidate layer has no author). `unknown` when neither is set. |
| `XDG_CONFIG_HOME` | On Linux, `ifc-lite mcp install --client claude-desktop` writes `$XDG_CONFIG_HOME/Claude/` (default `~/.config/Claude/`). |

## Project templates

The example scripts that `create-ifc-lite` writes for the `server` and `server-native` templates (`src/example.ts`, `src/example-stream.ts`) read `SERVER_URL`, the processing server to call. The default is `http://localhost:3001` for `server` and `http://localhost:8080` for `server-native`.

## Collaboration server

These complete the table in [Collaboration Server](./collab-server.md#configuration).

| Variable | Default | Effect |
|---|---|---|
| `PORT` | none | Listen port when `COLLAB_PORT` is not set. |
| `COLLAB_IDLE_UNLOAD_MS` | `300000` (5 min) | Unload a room after it has had no peers for this long. It reloads from disk on the next connect. `0` turns unloading off. |
| `COLLAB_TRUST_PROXY` | off | `1` or `true` trusts `X-Forwarded-For` for the token-mint rate limit (only with `COLLAB_TOKEN_SECRET`). Set it only behind a reverse proxy you control. |
| `COLLAB_BLOB_GC` | on | `0` or `false` turns off the sweep that deletes unreferenced geometry blobs. |
| `COLLAB_BLOB_GC_INTERVAL_MS` | `21600000` (6 h) | Time between sweeps. |
| `COLLAB_BLOB_GC_GRACE_MS` | `86400000` (24 h) | Minimum age before an unreferenced blob is deleted. At least `60000`. |
| `COLLAB_LAYER_REGISTRY` | off | `1` or `true` turns on the layer registry. It stores its data in `COLLAB_DATA_DIR`. |
| `COLLAB_REGISTRY_WEBHOOK_URL` | none | URL the layer registry notifies of changes. |
| `COLLAB_REGISTRY_WEBHOOK_SECRET` | none | Secret for that webhook. Used only with `COLLAB_REGISTRY_WEBHOOK_URL`. |

An invalid sweep interval or grace period stops the server at start-up.

## Cloud gateway

| Variable | Default | Effect |
|---|---|---|
| `CLOUD_INSECURE_LOCALHOST` | off | `true` lets `CLOUD_VIEWER_ORIGIN` be an `http:` origin on `localhost`, `127.0.0.1` or `[::1]`, for local testing. With it set, a non-local origin is refused. |

The other `CLOUD_*` variables are in the [gateway deployment instructions](https://github.com/LTplus-AG/ifc-lite/blob/main/deploy/cloud/railway.md).

## Rust geometry and export switches

These are read by the Rust crates. The geometry switches are read once per process; `IFC_LITE_GLB_STREAM_THRESHOLD_MB` is read on each GLB export. A WebAssembly build has no process environment, so the defaults always apply there. They are for diagnosing geometry and tuning native runs.

| Variable | Default | Effect |
|---|---|---|
| `IFC_LITE_CSG_BUDGET` | `500000` | Per-boolean cap on exact-arithmetic escalations. Over the cap the cut falls back to a box cut. `0` removes the cap and also the per-element cap. Overrides the value the code sets. |
| `IFC_LITE_CSG_ELEMENT_BUDGET` | `100000` | The same cap summed over all booleans of one element, on the batched geometry path. `0` removes it. Ignored when the per-boolean cap is off. |
| `IFC_LITE_FAST_CUT_RATIO` | `0.10` | In the low preview tessellation tiers, skip a cut whose cutter is smaller than this fraction of its host. |
| `IFC_LITE_VOID_2D` | on | `0` turns off the 2D opening subtraction path. |
| `IFC_LITE_PRISM_CUT` | on | `0` turns off the analytic prism subtraction path. |
| `IFC_LITE_VOID_UNION` | on | `0` turns off the union of coaxial and overlapping openings before cutting. |
| `IFC_LITE_RECT_PARAM` | on | `0` turns off the parametric rectangular-opening path. `IFC_LITE_RECT_FAST=0` turns off this path as well. |
| `IFC_LITE_HALFSPACE_CAP_OFF` | unset | Any value stops closing the cut face of an unbounded `IfcHalfSpaceSolid` difference. |
| `IFC_LITE_DEDUP_EXTRA` | off | `1` extends geometry content de-duplication to more item types. |
| `IFC_LITE_GLB_STREAM_THRESHOLD_MB` | `64` | Input size above which GLB export uses the streaming assembler. `0` never streams. |

Each `0` switch turns off one fast path, and its cases go to the general path instead. Leave them unset for production. [Mesh Determinism](../architecture/mesh-determinism.md) describes `IFC_LITE_RECT_FAST`, `IFC_LITE_LOCAL_FRAME` and `IFC_LITE_DISABLE_DEGENERATE_BACKSTOP`.

## Tests

| Variable | Effect |
|---|---|
| `IFC_LITE_REQUIRE_FIXTURES` | `1` makes Rust tests fail when a catalogued fixture is missing instead of skipping. `0` or empty skips. Any other value fails. CI sets `1`. |
| `IFCLITE_TRIANGULATION_ALT` | Any value switches triangulation to the second ear-clipper. It has an effect only when the `ifc-lite-geometry` crate is built with the test-only `triangulation-alt` feature. |

## Covered in other guides

| Area | Where |
|---|---|
| Processing server (`IFC_*`, `IFC_MEM_BUDGET_MB`, ...) | [Server Guide](./server.md) |
| Viewer configuration, processing server URL (`VITE_VIEWER_CONFIG_URL`, `VITE_IFC_SERVER_URL`, `VITE_USE_SERVER`) | [Configuring a Deployment](./viewer-deployment-config.md), [Server Guide](./server.md) |
| Collaboration (`COLLAB_*`, `VITE_COLLAB_*`) | [Collaboration Server](./collab-server.md) |
| Cloud sources (`VITE_CLOUD_HOSTED`, `VITE_AUTODESK_HOSTED`) | [Cloud Sources](./cloud-sources.md) |
| Analytics (`VITE_POSTHOG_*`) | [Privacy](./privacy.md) |
| BCF token relay (`BCF_*`) | [BCF Collaboration](./bcf.md) |
| Local registry (`VITE_REGISTRY_ENABLED`, `IFC_REGISTRY_TARGET`; the build derives `VITE_REGISTRY_ADDRESS` from them) | [Model Registry](./local-registry.md) |
| BCF outbox (`IFCLITE_BCF_OUTBOX_DIR`) | [MCP for AI Agents](./mcp.md), [CLI Toolkit](./cli.md) |
| Retained engine (`IFCLITE_RETAINED_ENGINE`) | [CLI Toolkit](./cli.md) |
| Source packages (`VITE_AUTODESK_CLIENT_ID`, `VITE_BUILDAGIL_CLIENT_ID`, ...) | Each `packages/source-*` README |
