# Configuring the Viewer for a Deployment

A host that embeds or deploys the viewer for its users can choose which features those users see. One organisation wants view and inspect only, another adds checking or AI later. The host hands the stock viewer a configuration at start. No fork and no build per organisation.

!!! warning "Presentation, not protection"
    A feature that is switched off is not rendered or started. Its code still ships in the bundle, and a person with the browser's developer tools can reach it. Whatever must not happen (reading a model, writing one, calling a paid service) has to be refused by the server that owns it.

## The configuration

```json
{
  "version": 1,
  "features": { "default": "all", "disable": ["privacy.analytics", "privacy.notice"] },
  "locale": "de"
}
```

| Member | Meaning |
| --- | --- |
| `version` | Always `1`. Any other value is refused. |
| `features.default` | `"all"`: every feature is on except those in `disable`. `"none"`: every feature is off except those in `enable`. |
| `features.enable`, `features.disable` | Feature ids. Only the list that matches `default` is read. Ids the viewer does not know are ignored, so a config written for a newer viewer still works on an older one. |
| `locale` | A BCP 47 tag the host prefers. It is the default: a language the user chose in Settings wins, and the browser's languages come after it. |

Members this version does not know are ignored, so a configuration written for a newer viewer still loads. With no configuration every feature is on and the viewer behaves as it always has.

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
