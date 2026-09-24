---
"@ifc-lite/data": patch
---

`@ifc-lite/data` builds for the browser again. 5.3.0 exported `readPackageVersion` from the package index with a static `node:fs` import, so every Vite app that bundles `@ifc-lite/data` failed its production build on `"readFileSync" is not exported by "__vite-browser-external"`. `node:fs` is now loaded inside the function through `process.getBuiltinModule`, which only the CLI and the MCP server call, on Node 22.13 or later. A new test bundles the package index for the browser and fails on any Node builtin reaching it.
