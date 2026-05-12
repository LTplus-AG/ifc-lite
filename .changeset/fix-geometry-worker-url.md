---
"@ifc-lite/geometry": patch
---

Fix published worker URLs to reference the emitted JavaScript file.

`@ifc-lite/geometry` starts parallel geometry processing by constructing
module workers from `geometry-parallel`. The published npm package includes
`dist/geometry.worker.js`, but `dist/geometry-parallel.js` still points at
`./geometry.worker.ts`, so consumers can fail to load the worker at runtime.

Keep source worker URLs pointing at TypeScript files for in-repo Vite builds,
and extend the post-build rewrite so published `dist/index.js` and
`dist/geometry-parallel.js` point at the emitted JavaScript worker files.
