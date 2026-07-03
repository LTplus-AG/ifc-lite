---
"@ifc-lite/sandbox": patch
---

Fix `naiveTypeStrip` mangling namespace imports on the esbuild-free fallback path. The `as`-cast removal regex only protected the `import { Foo as Bar }` alias form, so `import * as utils from 'x'` was rewritten to the invalid `import * from 'x'`, which then survived module-syntax stripping and reached QuickJS verbatim. The negative lookbehind now also excludes `* as name`, so namespace imports are stripped correctly.
