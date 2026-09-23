---
"@ifc-lite/cli": patch
---

Fix `ext init`'s scaffolded starter extension: `hello.js` used `export default function hello(ctx)` and called `ctx.log`/`ctx.notify`, neither of which the extension host or the test runner support (entry scripts are non-module and always invoke a top-level function named `run`; `ctx` is `{ bim }`). The scaffolded manifest also declared zero tests. A freshly scaffolded bundle's own starter command and test now run under `ifc-lite ext test` out of the box.
