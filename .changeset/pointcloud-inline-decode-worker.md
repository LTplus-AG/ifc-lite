---
"@ifc-lite/pointcloud": patch
---

Inline the streaming decode worker as a `Blob`-URL bundle so consumers no
longer hit Vite's IIFE/ES format conflict (issue #666). The published
`dist/streaming/inline-worker.js` now ships the worker shell + all six
format sources (LAS / LAZ-loader / PLY / PCD / E57 / ASCII) as a single
~225 KB IIFE string; `worker-client` lazy-imports it on first
`createDecodeWorkerSource()` call and spawns the worker via
`URL.createObjectURL(new Blob([code]))`. Workspace dev keeps the
`new Worker(new URL('./decode-worker.ts', import.meta.url))` fallback
path for HMR + source maps. LAZ's `laz-perf` wasm asset is still fetched
at runtime via `import.meta.url`, which doesn't resolve from a `Blob`
worker — LAZ-from-the-inline-path users need to pass a custom `spawn`
callback that yields a worker capable of fetching the wasm (documented
in the README).
