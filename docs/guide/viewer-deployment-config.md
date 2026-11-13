# Configuring the Viewer for a Deployment

A host that embeds or deploys the viewer for its users can choose which features those users see. One organisation wants view and inspect only, another adds checking or AI later. The host hands the stock viewer a configuration at start. No fork and no build per organisation.

!!! warning "Presentation, not protection"
    A feature that is switched off is not rendered or started. Its code still ships in the bundle, and a person with the browser's developer tools can reach it. Whatever must not happen (reading a model, writing one, calling a paid service) has to be refused by the server that owns it.

## The configuration

```json
{
  "version": 1,
  "features": { "default": "all", "disable": ["privacy.analytics", "privacy.notice"] },
  "locale": "de",
  "server": { "url": "/v1/viewing/processor" },
  "open": {
    "processedModel": {
      "sha256": "a91f9cf15d3f70fdd707d8567b5ade051e706af3a807367fa23fc9813f31d96a",
      "bytes": 18587273,
      "name": "Haus A.ifc"
    }
  }
}
```

| Member | Meaning |
| --- | --- |
| `version` | Always `1`. Any other value is refused. |
| `features.default` | `"all"`: every feature is on except those in `disable`. `"none"`: every feature is off except those in `enable`. |
| `features.enable`, `features.disable` | Feature ids. Only the list that matches `default` is read. Ids the viewer does not know are ignored, so a config written for a newer viewer still works on an older one. |
| `locale` | A BCP 47 tag the host prefers. It is the default: a language the user chose in Settings wins, and the browser's languages come after it. |
| `server.url` | The processing server the viewer asks for server-processed models: a path on the viewer's own origin starting with `/` (recommended; put the server behind your proxy there), or an absolute `https:` URL (`http:` only when the viewer page itself is served over `http:`), with no query, fragment or credentials. Anything else, including a path whose `..` segments leave the origin, refuses the configuration. When present it overrides the build's `VITE_IFC_SERVER_URL`; without it the build-time URL still applies. In a build with `VITE_USE_SERVER=true` it also receives uploads of IFC files opened from disk. |
| `open.processedModel` | A model the processing server has already processed, opened as soon as the viewer mounts. `sha256` is the SHA-256 of the source IFC (64 hex characters, either case). `bytes` is its size: a positive whole number, or `0` when unknown (the model then streams and its size shows as unknown). `name` is the non-empty name to show. The IFC itself never reaches the browser: the viewer asks `server.url` for the stored result by hash. With `open` set, a `?processed=` or `?model=` in the page URL is ignored (each logged once), so neither replaces the host's model; without it, both work as before. A collaboration link (`?room=`) is not covered: where collaboration is enabled it still joins its room, and the room's model loads as well as the host's. |

Members this version does not know are ignored, so a configuration written for a newer viewer still loads. Members it does know are checked strictly: a malformed `server` or `open` refuses the whole configuration, like any other invalid member.

The hash selects a stored result; it does not grant access to it. Decide who may read a result where `server.url` is served, on every request (see the processing server guide, "Opening a stored result without the file"). With no configuration every feature is on and the viewer behaves as it always has.

What cannot be switched off is the baseline: the 3D view and its navigation, selection, the model tree, the properties panel, search, visibility and isolation, the command palette and settings.

## The feature catalogue

Every production build contains `features.json` next to `index.html`. The dev server answers the same path. It lists each switchable feature with a stable id, a group, an English label and a description of what the user loses:

```json
{
  "version": 1,
  "groups": [{ "id": "privacy", "label": "Telemetry and privacy" }],
  "features": [
    {
      "id": "privacy.notice",
      "group": "privacy",
      "label": "Privacy notice",
      "description": "The first-visit notice about the local action log and hosted analytics."
    }
  ]
}
```

Read the catalogue from the viewer build you serve and render your switches from it. Do not hardcode ids: the build you serve is the one that knows which features it can hide. An id is never renamed or reused once shipped.

The source of the catalogue is `apps/viewer/src/lib/features/catalogue.ts`.

## Handing the configuration to the viewer

### Stock build: a URL

Build the viewer with `VITE_VIEWER_CONFIG_URL` set to a path on the origin that serves it:

```bash
VITE_VIEWER_CONFIG_URL=/api/viewer/config pnpm --filter @ifc-lite/viewer build
```

The viewer fetches that URL once before it mounts:

- Same origin only. A URL on another origin is refused without a request, and so is an answer that was redirected to another origin.
- Sent with the user's session (`credentials: 'same-origin'`), so the endpoint can answer per user.
- The page's `context` query parameter is forwarded. `/viewer/?context=abc` asks `/api/viewer/config?context=abc`, which lets the host say what the page is for.
- The answer must be JSON in the shape above.

The request starts before the viewer's code has loaded, so the two overlap. If it fails for any reason (network, no answer within 15 seconds, a status other than 2xx, a body that is not JSON, the wrong shape), the viewer does not start. It shows an error with a reload button (in English if even the translations cannot load). If the viewer's own code fails to load after a new deployment, the page reloads once instead. It never falls back to showing everything, because a deployment that restricts features must not expose them when its configuration endpoint is down.

### Your own entry: an object

A host that builds the viewer from source with its own entry file passes the same object. It goes through the same check as a fetched one: an invalid configuration throws instead of starting with everything on.

<!-- docs-check: skip -->
```ts
import { mountViewer } from './bootstrap';

mountViewer(document.getElementById('root')!, {
  config: { version: 1, features: { default: 'all', disable: ['privacy.analytics'] } },
});
```

The feature set is fixed for the lifetime of the page.

The embed viewer (`apps/viewer-embed`) does not take a configuration yet: it starts through the same runtime start with none, so every feature is on.

## Notes on individual features

- `privacy.analytics` off means the analytics client is never initialised, so no request reaches the analytics host, and the opt-out setting is not shown. `privacy.vercel-analytics` off means the hosting platform's page-view script is never injected.
