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
| `server.url` | The processing server the viewer asks for server-processed models: a path on the viewer's own origin starting with `/` (recommended; put the server behind your proxy there), or an absolute `https:` URL (`http:` is accepted on an HTTP viewer page or for `localhost`, `127.0.0.1`, and `[::1]`), with no query, fragment or credentials. Anything else, including a path whose `..` segments leave the origin, refuses the configuration. When present it overrides the build's `VITE_IFC_SERVER_URL`; without it the build-time URL still applies. In a build with `VITE_USE_SERVER=true` it also receives uploads of IFC files opened from disk. |
| `open.processedModel` | A model the processing server has already processed, opened as soon as the viewer mounts. `sha256` is the SHA-256 of the source IFC (64 hex characters, either case). `bytes` is its size in bytes, a whole number; `0` when unknown (the model then streams and its size shows as unknown). `name` is the non-empty name to show. It needs a processing server: `server.url`, or the build's `VITE_IFC_SERVER_URL`. The IFC itself never reaches the browser: the viewer asks the processing server for the stored result by hash. With `open` set, a `?processed=` or `?model=` in the page URL is ignored and a collaboration link (`?room=`) does not join its room (each logged once), so none of them replaces the host's model. A host entry can also start a model with the `mountViewer` option `processedModel` or open one later using the returned handle. See [opening processed models](./server.md#opening-a-stored-result-without-the-file). |
| `open.federation` | Several processed models opened together as one federation. `id` names the federation (non-empty, at most 128 characters). `slots` lists 1 to 64 models; the first is the primary model, the others join it. Each slot has `slot` (the host's stable id for it, unique in the federation, at most 128 characters; the loaded model keeps it as its id), `label` (what the model list shows, at most 120 characters), `sha256`, `bytes` and `name` (as in `open.processedModel`), `visible` (whether it starts shown), and an optional `transform`. When `federation` is present the viewer uses it and ignores `processedModel`; see [Opening a federation](#opening-a-federation). |

Members this version does not know are ignored, so a configuration written for a newer viewer still loads. Members it does know are checked strictly: a malformed `server` or `open` refuses the whole configuration, like any other invalid member.

The hash selects a stored result; it does not grant access to it. Decide who may read a result where `server.url` is served, on every request (see the processing server guide, "Opening a stored result without the file"). With no configuration every feature is on and the viewer behaves as it always has.

What cannot be switched off is the baseline: the 3D view and its navigation, selection, the model tree, the properties panel, search, visibility and isolation, the command palette and settings.


## Opening a federation

```json
{
  "version": 1,
  "server": { "url": "/v1/viewing/processor" },
  "open": {
    "processedModel": { "sha256": "a91f9cf15d3f70fdd707d8567b5ade051e706af3a807367fa23fc9813f31d96a", "bytes": 18587273, "name": "Haus A.ifc" },
    "federation": {
      "id": "workspace-7",
      "slots": [
        { "slot": "arch", "label": "Architecture", "sha256": "a91f9cf15d3f70fdd707d8567b5ade051e706af3a807367fa23fc9813f31d96a", "bytes": 18587273, "name": "Haus A.ifc", "visible": true },
        { "slot": "struct", "label": "Structure", "sha256": "5e0c4b0b2f1b6f1f7d3c5f0c5b8e0f2a9d1c3e5f7a9b1d3f5e7a9c1e3f5a7b9d", "bytes": 9112004, "name": "Tragwerk.ifc", "visible": false,
          "transform": [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 12.5, 0, 0, 1] }
      ]
    }
  }
}
```

Every slot opens from the processing server by hash, like `open.processedModel`: no IFC reaches the browser. The first slot loads as the primary model. The others start once it and its properties have loaded (or failed), at most two at a time, in slot order; the progress bar counts the models opened. Each one registers in its own ID range together with its properties, so selection, properties, picking, hide and isolate, section planes, clash input and BCF viewpoints work across the slots as they do for local files federated by hand.

A slot that cannot be opened (not stored, no access, server busy, or its properties not available yet) is listed as failed with its reason, next to the models that did load, and never stops the other slots. Its row in the model list offers Retry, which loads that slot again; the load card shows only the latest error. Retrying a failed primary opens the whole federation again, because the primary replaces the scene. A primary whose properties do not arrive keeps its geometry, is listed as failed with Retry, and the other slots still load. Opening another model or another federation replaces the federation, also while its primary is still loading: slots that had not started do not start, and a replaced federation adds nothing to the new one.

`transform`, when present, is 16 finite numbers: a 4x4 matrix, column-major, in metres, with Z up, in the slot model's own IFC world frame (its project coordinates). The heading turns about that frame's origin, 0,0,0 in the IFC file, whatever origin shift the processing server or the viewer applies to keep large coordinates precise; the viewer converts it into its own frame. The viewer places models by a heading about the vertical axis and a translation, so the matrix must be exactly that: a rotation about Z (no tilt, scale, mirroring or shear) followed by a translation, bottom row `0 0 0 1`, to within 1e-6. Any other matrix refuses the configuration. The placement is the model's starting position, not a move the user can undo; the user can still reposition the model.

Viewers older than this member ignore `federation` but refuse an `open` without `processedModel`. To keep them working, send `processedModel` too (for example the first slot's model): they open that one model, and this viewer opens the federation.

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

- Same origin only. A URL on another origin is refused without a request, and a redirect to another origin is not followed.
- Sent with the user's session (`credentials: 'same-origin'`), so the endpoint can answer per user.
- The page's `context` query parameter is forwarded. `/viewer/?context=abc` asks `/api/viewer/config?context=abc`, which lets the host say what the page is for.
- The answer must be JSON in the shape above.

The request starts before the viewer's code has loaded, so the two overlap. If it fails for any reason (network, no answer within 15 seconds, a status other than 2xx, a body that is not JSON, the wrong shape), the viewer does not start. It shows an error with a reload button (in English if even the translations cannot load). If the viewer's own code fails to load after a new deployment, the page reloads once instead. It never falls back to showing everything, because a deployment that restricts features must not expose them when its configuration endpoint is down.

### Your own entry: an object

A host that builds the viewer from source with its own entry file passes the same object. It goes through the same check as a fetched one: an invalid configuration throws instead of starting with everything on.

```ts
import { mountViewer } from '@/bootstrap';

mountViewer(document.getElementById('root')!, {
  config: { version: 1, features: { default: 'all', disable: ['privacy.analytics'] } },
});
```

The feature set is fixed for the lifetime of the page.

The embed viewer (`apps/viewer-embed`) does not take a configuration yet: it starts through the same runtime start with none, so every feature is on.

## Notes on individual features

- `privacy.analytics` off means the analytics client is never initialised, so no request reaches the analytics host, and the opt-out setting is not shown. `privacy.vercel-analytics` off means the hosting platform's page-view script is never injected.
- `edit.model` off refuses every change to a model, including changes made by a script, because the refusal sits where edit mode is entered and where a change is committed.
- `automate.extensions` off does not start installed extensions.
- `ai.assistant` off hides every AI surface, and Flow runs get no model, so AI nodes are refused.
- `collab.sessions` also needs a collaboration server configured in the build (`VITE_COLLAB_ENABLED`).
- `edit.placement` moves whole models and edits their georeferencing. Georeferencing is model data, so its editing also needs `edit.model`; repositioning a model does not.
- `privacy.third-party` off stops the hosted icon font (the model tree then shows one generic icon per class), map tiles, bSDD (the Properties tab, the semantic profile search and the AI agent's bSDD tools), the 3D world context, and the projection and terrain lookups that ask epsg.io, cdn.proj.org and Open-Meteo.
- `export.files` covers saving the model as a file, including script and extension downloads. Reports and other files that panels save (lists, BCF, IDS reports, drawings) are not covered yet.
- `files.samples` off also removes the guided tours that load the sample project when no model is open. The ribbon tour needs no model and stays.
- `files.local` off leaves models to arrive through the host: the `?model=` URL parameter keeps working, since the host controls the URL it links to. With Cloud sources off too, the start screen says the model comes from the page that linked here.
