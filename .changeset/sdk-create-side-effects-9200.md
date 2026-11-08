---
"@ifc-lite/create": patch
"@ifc-lite/sdk": patch
"@ifc-lite/viewer": patch
---

`@ifc-lite/create` and `@ifc-lite/sdk` now declare `sideEffects` (#9200), so bundlers can drop the modules an app imports through the package index but never uses. `@ifc-lite/create` declares `false`. `@ifc-lite/sdk` names only its index: loading it registers the parser's schema check with `@ifc-lite/mutations`, which must still run whenever the SDK loads. The viewer also keeps the QuickJS runtime core out of its eager `sandbox` chunk; it now loads with the first script run. Nothing changes at runtime.
