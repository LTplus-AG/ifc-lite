---
'@ifc-lite/renderer': patch
'@ifc-lite/geometry': patch
'@ifc-lite/parser': patch
---

Add the missing MPL-2.0 file headers these packages ship without (#4087).

`packages/renderer/src/{bvh,raycaster,snap-detector}.ts`, `packages/geometry/src/huge-file-error.ts` and three test files carried no license notice at all. `scripts/add-license-headers.mjs --check` now runs in CI, so the omission cannot recur. No behaviour, API surface or output changes: every edit is a four-line comment at the top of a file.
