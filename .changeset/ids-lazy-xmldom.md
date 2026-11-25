---
"@ifc-lite/ids": patch
---

Importing `@ifc-lite/ids` no longer loads `@xmldom/xmldom`. The Node fallback for a missing `DOMParser` used to run as a top-level `await import()` whenever `process.versions.node` was set, which is also true in Cloudflare workerd, so any bundle that reached the IDS parser (including `@ifc-lite/sdk`) failed to load there unless a `DOMParser` placeholder was installed first. The fallback now loads on the first `parseIDS` call that needs it, through `process.getBuiltinModule`; parsing on Node behaves as before, and a runtime with neither a `DOMParser` nor Node reports why in the `IDSParseError` details.
