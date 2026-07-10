# @ifc-lite/embed-sdk

A lightweight SDK for embedding the ifc-lite 3D viewer in any web page. `IFCLiteEmbed.create` mounts an iframe pointed at the hosted embed viewer and gives you a promise-based API for controlling it over postMessage: load models, select and isolate entities, colorize, move the camera, cut sections, and subscribe to viewer events. Works in dashboards and BI tools that allow custom iframes.

## Install

```bash
npm install @ifc-lite/embed-sdk
```

## Usage

```ts
import { IFCLiteEmbed } from '@ifc-lite/embed-sdk';

const viewer = await IFCLiteEmbed.create({
  container: '#viewer',
  modelUrl: 'https://example.com/model.ifc',
  theme: 'dark',
});

await viewer.select([42, 43]);
viewer.on('entity-selected', (data) => console.log(data));
```

## Features

- One-call setup: `IFCLiteEmbed.create({ container, modelUrl, theme, controls, view, camera, ... })`
- Model loading: `loadModel(url)`, `loadModelBuffer(buffer)` (zero-copy transfer), federation via `addModel` / `removeModel`
- Selection and visibility: `select`, `selectByGuid`, `clearSelection`, `isolate`, `hide`, `show`, `showAll`
- Appearance: `setColors`, `resetColors`, `setTheme`, `setTypeVisibility`
- Camera and sections: `fitToView`, `setCamera`, `setView`, `setSection`
- Data out: `getProperties(id)`, `getModelInfo()`, `getScreenshot()`
- Events: `ready`, `model-loaded`, `entity-selected`, `entity-hovered`, `camera-changed`, `section-changed`, and more via `on(event, cb)`
- Strict origin checks on every message; auth tokens are sent via postMessage, not the URL

Protocol types are shared with the viewer through `@ifc-lite/embed-protocol`.

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
