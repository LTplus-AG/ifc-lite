---
"@ifc-lite/parser": patch
---

Point the published worker URL at the file the package ships.

`dist/worker-parser.js` carried `new URL('./parser.worker.ts', import.meta.url)`
straight from source, but the tarball contains only `dist/parser.worker.js`. So
`new WorkerParser()` rejected through `worker.onerror` for every npm consumer,
and a bundler resolving the literal at build time failed outright — `vite build`
stopped even when the app passed its own `workerUrl`. Affected 6.5.0 and 7.0.0.

The build now rewrites those specifiers to the emitted `.js`, and a second step
re-derives from the emitted files whether every `new URL('./…', import.meta.url)`
resolves to something `dist` holds, failing the build when one does not.
