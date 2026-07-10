---
'@ifc-lite/codegen': patch
'@ifc-lite/embed-protocol': patch
'@ifc-lite/embed-sdk': patch
'@ifc-lite/wasm': patch
'create-ifc-lite': patch
---

Package metadata hygiene: correct the @ifc-lite/codegen license field to MPL-2.0 (the source has always carried MPL headers; the MIT value was a scaffolding accident) and give it a files allowlist so the npm tarball ships dist, schemas, and README instead of the whole package directory. Add the missing publishConfig, homepage, and bugs fields to codegen, embed-protocol, embed-sdk, and wasm, and homepage/bugs to create-ifc-lite, matching the rest of the workspace.
