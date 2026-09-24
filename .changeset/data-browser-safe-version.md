---
"@ifc-lite/data": patch
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

`@ifc-lite/data` builds for the browser again. 5.3.0 exported `readPackageVersion` from the package index with a static `node:fs` import, so every Vite app that bundles `@ifc-lite/data` failed its production build on `"readFileSync" is not exported by "__vite-browser-external"`. `node:fs` is now loaded inside the function through `process.getBuiltinModule`, which only the CLI and the MCP server call. That API exists from Node 20.16 and 22.3, so `@ifc-lite/cli` and `@ifc-lite/mcp` now declare `engines.node` `>=20.16 <21 || >=22.3` instead of `>=18.0.0` (Node 18 reached end of life in April 2025); on an older Node, `--version` would otherwise report `0.0.0-unknown`. A new test bundles the package index for the browser and fails on any Node builtin reaching it.
