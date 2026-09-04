---
'@ifc-lite/bcf': patch
'@ifc-lite/bcf-api': patch
'@ifc-lite/cache': patch
'@ifc-lite/clash': patch
'@ifc-lite/codegen': patch
'@ifc-lite/collab': patch
'@ifc-lite/collab-server': patch
'@ifc-lite/diff': patch
'@ifc-lite/drawing-2d': patch
'@ifc-lite/export': patch
'@ifc-lite/extensions': patch
'@ifc-lite/geometry': patch
'@ifc-lite/ids': patch
'@ifc-lite/ifcx': patch
'@ifc-lite/lens': patch
'@ifc-lite/lists': patch
'@ifc-lite/merge': patch
'@ifc-lite/mutations': patch
'@ifc-lite/pointcloud': patch
'@ifc-lite/renderer': patch
'@ifc-lite/sandbox': patch
'@ifc-lite/server-client': patch
'@ifc-lite/spatial': patch
'@ifc-lite/wasm': patch
---

Corrected the code samples on each package's npm landing page: the README fences are now typechecked against the package's real exports, so the snippets import what they call, declare the values they read, and no longer show removed options or renamed methods. Patch-bumping every package whose README changed so the corrections actually reach npmjs.com.
