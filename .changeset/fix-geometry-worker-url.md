---
"@ifc-lite/geometry": patch
---

Fix published worker URLs to reference the emitted JavaScript file.

`@ifc-lite/geometry` starts parallel geometry processing by constructing
module workers from `geometry-parallel`. The published npm package includes
`dist/geometry.worker.js`, but `dist/geometry-parallel.js` still points at
`./geometry.worker.ts`, so consumers can fail to load the worker at runtime.

Point the source at `./geometry.worker.js`, which is the emitted file that is
published to npm. This also removes the post-build string replacement from the
package build script; it patched `dist/index.js`, while the worker URL lives in
`dist/geometry-parallel.js`.
