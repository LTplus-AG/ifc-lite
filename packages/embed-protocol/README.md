# @ifc-lite/embed-protocol

Shared postMessage protocol types for the ifc-lite embed viewer and `@ifc-lite/embed-sdk`. Both sides of the iframe boundary import from this package, so commands, events, and payloads stay type-safe across the postMessage channel. If you are embedding the viewer in your own page, you usually want `@ifc-lite/embed-sdk` instead; this package is for tooling that talks the wire protocol directly.

## Install

```bash
npm install @ifc-lite/embed-protocol
```

## Usage

```ts
import { createCommand, isEmbedMessage } from '@ifc-lite/embed-protocol';

// Caller-provided: the embed viewer's <iframe> and its origin.
const iframe = document.querySelector<HTMLIFrameElement>('iframe#embed')!;
const embedOrigin = new URL(iframe.src).origin;

// Type-safe command construction (payload checked against the command type)
const msg = createCommand('SELECT', { ids: [42, 43] }, crypto.randomUUID());
iframe.contentWindow?.postMessage(msg, embedOrigin);

window.addEventListener('message', (event) => {
  if (!isEmbedMessage(event.data)) return; // ignore unrelated traffic
  console.log(event.data.type, event.data.data);
});
```

## Exports

- Constants: `EMBED_SOURCE`, `PROTOCOL_VERSION`
- Envelope: `EmbedMessageEnvelope`, `EmbedError`
- Commands (host to viewer): `InboundCommandType`, `InboundPayloads`, `CommandResponses` (LOAD_MODEL, SELECT, SET_COLORS, SET_CAMERA, GET_PROPERTIES, ...)
- Events (viewer to host): `OutboundEventType`, `OutboundPayloads` (READY, MODEL_LOADED, ENTITY_SELECTED, CAMERA_CHANGED, ...)
- Shared data types: `ModelStats`, `EntityProperties`, `ModelInfo`, `ViewPreset`, `SectionAxis`, `EmbedConfig`, `EmbedUrlParams`
- Helpers: `createCommand`, `createEvent`, `createResponse`, `isEmbedMessage`

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
