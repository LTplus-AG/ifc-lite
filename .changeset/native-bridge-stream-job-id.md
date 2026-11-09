---
"@ifc-lite/geometry": patch
---

`NativeBridge.processGeometryStreaming` now tags each stream with a `jobId` (passed to `get_geometry_streaming`) and ignores a `geometry-batch`, `geometry-packed-batch` or `geometry-color-update` event tagged for another stream, so two concurrent native streams no longer receive each other's batches. Events without a `jobId` are still accepted for shells that do not send one yet. If registering one of the stream's event listeners fails, the listeners already registered are released instead of staying attached for the life of the app, and `onError` is called.
