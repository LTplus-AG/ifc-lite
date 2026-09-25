---
"@ifc-lite/data": major
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
---

`@ifc-lite/data` builds for the browser again. 5.3.0 exported `readPackageVersion` and `UNKNOWN_VERSION` from the package root with a static `node:fs` import, so every Vite app that bundles `@ifc-lite/data` failed its production build on `"readFileSync" is not exported by "__vite-browser-external"` (#5767). Both now live on a Node-only subpath, `@ifc-lite/data/node`, and are no longer exported from the root (breaking: import them from `@ifc-lite/data/node`). `@ifc-lite/cli` and `@ifc-lite/mcp` import from there. A test bundles the package root for the browser and fails on any Node builtin reaching it.
