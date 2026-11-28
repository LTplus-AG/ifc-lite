# @ifc-lite/viewer-core

Interactive 3D viewer for IFC models: a self-contained WebGL 2 browser viewer served from a local Node HTTP server, with a REST command API and server-sent events for live control. This is the engine behind `ifc-lite view` and `ifc-lite analyze` in the CLI; scripts and external tools can drive the running viewer (colorize, isolate, section, camera) over plain HTTP.

## Install

```bash
npm install @ifc-lite/viewer-core
```

## Usage

```ts
import { startViewerServer } from '@ifc-lite/viewer-core';

const server = await startViewerServer({
  filePath: '/path/to/model.ifc',
  fileName: 'model.ifc',
  port: 3456, // 0 = auto-assign
  onReady: (port, url) => console.log(`Viewer at ${url}`),
});

// Push a command to all connected browser viewers
server.broadcast({ action: 'colorize', type: 'IfcWall', color: [1, 0, 0, 1] });
```

The same command channel is exposed over REST while the server runs:

```bash
curl -X POST http://127.0.0.1:3456/api/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"colorize","type":"IfcWall","color":[1,0,0,1]}'
```

Routes while the server runs (bound to `127.0.0.1`):

| Route | Purpose |
|---|---|
| `GET /events` | SSE stream of commands for the browser page |
| `POST /api/command` | Send one command (`action` must be in `VALID_ACTIONS`) |
| `POST /api/create` | Live element creation, when `createHandler` is passed |
| `POST /api/clear-created` | Drop the created IFC segments |
| `GET /api/export` | Download the created IFC segments |
| `GET /api/status` | Server status as JSON |

`@ifc-lite/viewer-core/url` exports `VIEWER_HOST` and `viewerUrl(port, path?)`
without loading the server, so clients can build the address cheaply.

## Features

- WebGL 2 renderer with selection, isolation, x-ray, section planes, camera presets, and per-entity colorization
- REST `/api/command` endpoint plus SSE push; `VALID_ACTIONS` lists the accepted actions (colorize, isolate, xray, flyto, highlight, section, colorByStorey, addGeometry, setView, camera, and more)
- `startViewerServer` returns a `ViewerServer` handle: `broadcast`, `clientCount`, and access to created IFC segments
- Optional `createHandler` wires the `/api/create` endpoint for live element creation
- Streaming adapters (`createStreamingViewerAdapter`, `createStreamingVisibilityAdapter`) and `getViewerHtml` for embedding the page elsewhere
- WASM-powered parsing and geometry, no browser plugins required

Note: the npm package name is `@ifc-lite/viewer-core`; in the monorepo it lives at `packages/viewer`.

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
