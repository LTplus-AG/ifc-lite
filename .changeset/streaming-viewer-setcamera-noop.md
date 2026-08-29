---
'@ifc-lite/viewer-core': patch
---

Fix `bim.viewer.setCamera()` doing nothing against the streaming viewer — the server started by `ifc-lite view <file.ifc> --port PORT`, driven either by another command's `--viewer PORT` flag or by the MCP server.

`createStreamingViewerAdapter().setCamera(state)` (`src/streaming-viewer.ts`) has always POSTed `{ action: 'camera', state }` to the server, and the server has always accepted `'camera'` as a valid action and broadcast it to every connected browser tab — but the browser's own command switch (`handleCommand` in `src/viewer-html.ts`) had no `case 'camera'` at all, so the command fell into the `default: console.log('Unknown command', cmd)` branch and the 3D camera never moved. Every other `ViewerBackendMethods` call this adapter exposes (`colorize`, `flyTo`, `setSection`, …) reaches the browser and takes effect; `setCamera` alone was a silent no-op end to end, invisible to the caller since the adapter is fire-and-forget by design.

`handleCommand` now applies `state.position`/`state.target` to the viewer's orbit camera (`camTarget`/`camDist`/`camTheta`/`camPhi`), deriving distance and orientation from `position` relative to `target` when both are given. `state.mode`/`state.up` are accepted but have no effect, since this viewer only ever renders in perspective.
