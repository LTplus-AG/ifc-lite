---
"@ifc-lite/geometry": minor
"@ifc-lite/parser": minor
"@ifc-lite/viewer": patch
---

Small `.ifc` files open without the set-up a large file needs. While the page is idle the viewer prepares one spare parser worker, used by the next parse of any size, and one spare geometry worker. An eligible pick hands that worker the file before the interface resets. The load uses the run only if it meshes with the same settings, and otherwise meshes as before. `?perf.fastPath=0` turns it off.

- `@ifc-lite/geometry`: `GeometryProcessor.meshingSettings()` returns the settings a processor meshes with (`GeometryMeshingSettings`); the worker pool forwards exactly these. `compileSharedWasmModule` is exported.
- `@ifc-lite/parser/browser`: `prepareSpareParser`, `hasSpareParserWorker` and `releaseSpareParserWorker` manage one spare parser worker that the next `WorkerParser` without a custom `workerUrl` takes.
