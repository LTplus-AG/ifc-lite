---
'@ifc-lite/viewer-core': patch
---

Fix `bim.viewer.clearSection()` enabling a section plane instead of removing one, against the streaming viewer server started by `ifc-lite view <file.ifc> --port PORT`.

`ViewerNamespace.clearSection()` calls `backend.viewer.setSection(null)`. `createStreamingViewerAdapter().setSection()` (`src/streaming-viewer.ts`) forwarded that verbatim as `{ action: 'section', section: null }`. The browser's `'section'` handler (`src/viewer-html.ts`) falls back to `cmd` itself when `cmd.section` is falsy, then defaults a missing axis to `'y'` and a missing position to the model's center — so a `null` section produced a brand-new horizontal section plane through the middle of the model instead of clearing anything. The server already exposes a dedicated `'clearSection'` action for this (used nowhere on the client side); `setSection(null)` now sends that instead of a `'section'` command with a null payload.
