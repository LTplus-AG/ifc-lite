# Embedding the Viewer

The embed viewer (`apps/viewer-embed`) is a stripped-down IFClite viewer for an `<iframe>`, for example in a dashboard or BI tool that allows custom iframes. A host page controls it over `postMessage`:

- [`@ifc-lite/embed-sdk`](https://github.com/LTplus-AG/ifc-lite/blob/main/packages/embed-sdk/README.md) mounts the iframe and wraps every command in a promise. Use it unless you need the wire protocol.
- [`@ifc-lite/embed-protocol`](https://github.com/LTplus-AG/ifc-lite/blob/main/packages/embed-protocol/README.md) holds the message types both sides share. Use it when you talk to the iframe yourself.

The embed starts with every viewer feature on. It does not read a [deployment configuration](./viewer-deployment-config.md) yet. It renders with WebGPU, so the visitor's browser must meet the [browser requirements](./browser-requirements.md); without WebGPU the `modelUrl` auto-load does not start.

## Quick start with the SDK

```bash
npm install @ifc-lite/embed-sdk
```

```typescript
import { IFCLiteEmbed } from '@ifc-lite/embed-sdk';

const viewer = await IFCLiteEmbed.create({
  container: '#viewer',
  theme: 'dark',
  view: 'front',
});

viewer.on('entity-selected', (e) => console.log(e.id, e.globalId, e.ifcType));

const stats = await viewer.loadModel('https://example.com/model.ifc');
console.log(stats.entities, stats.triangles);

const { resolved } = await viewer.selectByGuid(['2O2Fr$t4X7Zf8NOew3FLOH']);
if (resolved.length > 0) {
  await viewer.fitToView(resolved);
  const props = await viewer.getProperties(resolved[0]);
  console.log(props.propertySets);
}
```

Call `viewer.destroy()` when the host page no longer needs the viewer, for example in a component's unmount handler. It removes the iframe.

`IFCLiteEmbed.create()` appends an iframe to `container` with `src` set to `<origin>/v1?<options>`. It resolves after the handshake (below), not after a model has loaded: a `modelUrl` given to `create()` loads in the background. To run commands against a model, call `loadModel()` and await it, as above, or wait for the `model-loaded` event. If the handshake does not finish within `timeout` (default 15000 ms), it removes the iframe and rejects. Each later command rejects after 30 s without a reply.

### Options

All options except `container`, `origin`, `token` and `timeout` go into the iframe URL.

| Option | Meaning |
|---|---|
| `container` | CSS selector or element to mount the iframe in. Required. |
| `origin` | Origin of the embed viewer. Default `https://embed.ifclite.com`. Set it when you host the embed yourself. |
| `modelUrl` | Model to fetch on load. Only `http:` and `https:` URLs are accepted. |
| `autoLoad` | `false` mounts the viewer empty, so the host loads a model itself. |
| `theme` | `'light'` or `'dark'`. |
| `bg` | Background colour as 3 to 8 hex digits, without `#`. |
| `controls` | `'all'` (default), `'orbit'`, `'pan'` or `'none'`. Limits mouse, touch, keyboard and SpaceMouse navigation. SDK camera calls still work. |
| `hideAxis`, `hideScale` | `true` hides the axis triad or the scale bar. |
| `hideTypes` | IFC class names to hide, matched case-insensitively. This also hides the 2D symbolic overlay owned by `IfcAnnotation` or `IfcGridAxis`. The SDK has no call that shows them again. |
| `select`, `isolate` | Entity ids to select or isolate once the first model is on screen. Ids that are not positive integers are dropped. |
| `view` | Preset view: `top`, `bottom`, `front`, `back`, `left`, `right`. Wins over `camera`. |
| `camera` | `{ azimuth, elevation }` in degrees. The model is framed at that orientation. `zoom` is accepted but not applied. |
| `token` | Sent in the `INIT` message, never in the URL. |
| `timeout` | Handshake timeout in ms. Default 15000. |

### Methods

| Method | Effect |
|---|---|
| `loadModel(url)` | Replaces the scene with the model at `url`. Resolves to `{ entities, triangles, vertices }`. A fetch failure rejects. A file that fails to parse can still resolve, so check the counts. |
| `loadModelBuffer(buffer)` | Same, from an `ArrayBuffer`. The buffer is transferred, not copied. The viewer refuses buffers over 500 MB. |
| `addModel(url, name?)` | Adds a model next to the loaded ones. Resolves to the stats plus `modelId`. |
| `removeModel(modelId)` | Removes a model. Rejects with `NOT_FOUND` for an unknown id. |
| `select(ids)`, `clearSelection()` | Sets or clears the selection. An empty `ids` clears it. |
| `selectByGuid(guids)` | Selects by IFC `GlobalId` across all loaded models. Resolves to `{ resolved }`, the viewer ids it found. Unknown GUIDs are skipped, so `resolved` can be empty; then the selection is left unchanged. |
| `isolate(ids)`, `hide(ids)`, `show(ids)`, `showAll()` | Visibility. An assembly id is expanded to its parts. |
| `setColors(map)`, `resetColors()` | Colour overrides, keyed by entity id, as `[r, g, b, a]`. `resetColors()` restores the colours that `setColors()` replaced. |
| `fitToView(ids?)` | Frames `ids` (and selects them), or the whole scene. |
| `setCamera(azimuth, elevation)` | Rotates the camera around its current target. It does not reframe. |
| `setView(preset)` | Preset view. |
| `setSection({ axis, position, enabled, flipped })` | Section plane. `axis` is `'down'`, `'front'` or `'side'`. `position` is a percentage, clamped to 0 to 100. |
| `setTheme(theme, bg?)` | Theme, and the background when `bg` is given. |
| `setTypeVisibility(flags)` | Toggles `spaces`, `spatialZones`, `openings`, `virtualElements`, `site`, `ifcAnnotations`, `ifcGrid`, `structuralGlyphs`. Omitted flags stay as they are. `hideTypes` wins where both apply. |
| `getProperties(id)` | Attributes, property sets and quantity sets of one entity. |
| `getModelInfo()` | Loaded models: `modelId`, `name`, entity and triangle counts and visibility, plus totals. It lists no entity ids. |
| `getScreenshot()` | Not implemented yet: the viewer answers `NOT_IMPLEMENTED`, so the promise rejects. |
| `on(event, callback)` | Subscribes to an event. Returns an unsubscribe function. |
| `destroy()` | Removes the iframe and listener and rejects pending commands. |

Ids are the viewer's entity ids. With one model they are its STEP express ids. With several models each model's ids carry an offset, so get ids from `selectByGuid()` or from `entity-selected` and `entity-hovered` events.

Type-visibility toggles persist in `localStorage` on the embed's origin. Every host that uses the same embed origin shares them. Call `setTypeVisibility()` after load when you need a fixed starting state.

### Events

| SDK event | Payload |
|---|---|
| `model-loading` | `{ progress, phase }` |
| `model-loaded` | `{ entities, triangles, vertices }`. The type has an optional `modelId`, but the embed does not send it. Take the model id from the `addModel()` result. |
| `model-error` | `{ error: { code, message } }`. Sent with code `LOAD_FAILED` when the `modelUrl` auto-load cannot fetch the file (HTTP error, timeout). A file that downloads but fails to parse shows an error inside the viewer and sends no `model-error`. |
| `entity-selected` | `{ id, globalId?, modelId?, ifcType? }` |
| `entity-deselected` | none |
| `entity-hovered` | `{ id, globalId?, ifcType? }` |
| `camera-changed` | `{ azimuth, elevation }`. Fires for orbit, ViewCube, preset views and `setCamera()`, not for pan or zoom. At most one event per 100 ms, plus a final one when the camera settles. |
| `section-changed` | `{ axis, position, enabled }` |

`EventMap` also has `ready` (`{ version }`), but the iframe sends `READY` while `create()` is still pending, before you can call `on()`. Treat the resolved `create()` as the ready signal.

## URL-only use

The embed reads the same options from its query string, so a plain iframe works without the SDK:

```html
<iframe
  src="https://embed.ifclite.com/v1?modelUrl=https://example.com/model.ifc&theme=light&view=top&hideTypes=IfcSpace"
  style="width: 100%; height: 600px; border: none"
  allow="cross-origin-isolated"></iframe>
```

| Parameter | Format |
|---|---|
| `modelUrl`, `theme`, `bg`, `controls`, `view` | As the SDK options. |
| `autoLoad` | Any value except `false` loads. |
| `hideAxis`, `hideScale` | `true` |
| `hideTypes`, `select`, `isolate` | Comma-separated lists. |
| `camera` | `azimuth,elevation[,zoom]` |
| `demo` | Loads the demo model at `/demo/AC20-FZK-Haus.ifc`, unless `modelUrl` is also given. On the deployed site that path is proxied from `https://www.steptools.com/docs/stpfiles/ifc/AC20-FZK-Haus.ifc`. |
| `allowOrigin` | Comma-separated origins. When set, commands from any other origin are dropped. |
| `parentOrigin` | The host's origin. The embed sends model events there before the first command arrives. Without it, the embed uses the origin of `document.referrer`. |

Invalid values are ignored, and a bad `modelUrl` is logged to the console.

## The postMessage protocol

Every message is an envelope:

```json
{ "source": "ifc-lite-embed", "version": "1.0", "type": "SELECT", "requestId": "…", "data": { "ids": [42] } }
```

Commands go from host to iframe. Their `type` is one of `INIT`, `LOAD_MODEL`, `LOAD_MODEL_BUFFER`, `ADD_MODEL`, `REMOVE_MODEL`, `SELECT`, `SELECT_BY_GUID`, `CLEAR_SELECTION`, `ISOLATE`, `HIDE`, `SHOW`, `SHOW_ALL`, `SET_COLORS`, `RESET_COLORS`, `FIT_TO_VIEW`, `SET_CAMERA`, `SET_VIEW`, `SET_SECTION`, `SET_THEME`, `SET_TYPE_VISIBILITY`, `GET_PROPERTIES`, `GET_SCREENSHOT` and `GET_MODEL_INFO`. Payload types are `InboundPayloads` in `@ifc-lite/embed-protocol`.

A command with a `requestId` gets one reply of type `RESPONSE` whose `responseId` is that id. It carries `data`, or `error: { code, message }`. Error codes are `COMMAND_FAILED`, `NOT_FOUND`, `NOT_IMPLEMENTED`, `UNKNOWN_COMMAND` and `UNAUTHORIZED`. A command without a `requestId` gets no `RESPONSE`, and its errors are dropped. An `INIT` without one still triggers the `INIT_ACK` event.

Events go from iframe to host. Their `type` is one of `READY`, `INIT_ACK`, `MODEL_LOADING`, `MODEL_LOADED`, `MODEL_ERROR`, `ENTITY_SELECTED`, `ENTITY_DESELECTED`, `ENTITY_HOVERED`, `CAMERA_CHANGED` and `SECTION_CHANGED`. The SDK turns these into the kebab-case names above. `INIT_ACK` resolves `create()` and has no SDK event.

The handshake is `READY` (iframe), then `INIT` (host, optional `token` and `config`), then `INIT_ACK` (iframe). `config` takes `theme`, `bg`, `controls`, `hideAxis`, `hideScale` and `hideTypes`, with the same effect as the URL parameters.

```typescript
import { createCommand, isEmbedMessage } from '@ifc-lite/embed-protocol';

const iframe = document.querySelector<HTMLIFrameElement>('iframe#embed')!;
const embedOrigin = new URL(iframe.src).origin;

window.addEventListener('message', (event) => {
  // Check the window as well as the origin: another embed on the same origin must not drive this one.
  if (event.source !== iframe.contentWindow) return;
  if (event.origin !== embedOrigin || !isEmbedMessage(event.data)) return;
  if (event.data.type === 'READY') {
    iframe.contentWindow?.postMessage(createCommand('INIT', {}, crypto.randomUUID()), embedOrigin);
  }
  if (event.data.type === 'INIT_ACK') {
    iframe.contentWindow?.postMessage(
      createCommand('LOAD_MODEL', { url: 'https://example.com/model.ifc' }, crypto.randomUUID()),
      embedOrigin,
    );
  }
});
```

## Security

- The embed accepts commands only from its direct parent window. With `allowOrigin` set, it also checks the sender's origin.
- `READY` is the only message sent to `*`. Every other message is dropped, not queued, until a parent origin is known: from `parentOrigin`, the referrer, or the first valid command. The first command's origin then becomes the target for all replies and events.
- Model URLs from the query string and from `LOAD_MODEL` / `ADD_MODEL` must be `http:` or `https:`. Fetches time out after 60 s. The deployed site's Content Security Policy allows connections only to its own origin, `https:` and `blob:`, so on the hosted embed a model must be served over HTTPS.
- The SDK checks that every message comes from its own iframe and from `origin`.
- The shipped embed does not check the `INIT` token. A token sent through the SDK is not a form of access control. Protect model URLs on the server that serves them.

## Hosting the embed

`pnpm --filter @ifc-lite/viewer-embed dev` runs it locally, and `pnpm --filter @ifc-lite/viewer-embed build` writes `apps/viewer-embed/dist`. The deployed site sends the headers in [`apps/viewer-embed/vercel.json`](https://github.com/LTplus-AG/ifc-lite/blob/main/apps/viewer-embed/vercel.json): cross-origin isolation (`Cross-Origin-Embedder-Policy: credentialless`, `Cross-Origin-Opener-Policy: same-origin`), a Content Security Policy with `connect-src 'self' https: blob:` and `frame-ancestors *`, a proxy rewrite of `/demo/AC20-FZK-Haus.ifc` to steptools.com, and a rewrite of every other path to `index.html`. A model URL must allow cross-origin fetches from the embed's origin.
