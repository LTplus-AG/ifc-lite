---
"@ifc-lite/plugin-api": minor
"@ifc-lite/source-fixture": minor
---

The source provider contract can now describe writing back to a source. A provider may declare `capabilities.writeBack` with any of `new-version`, `new-file` and `new-location`, and implement the optional `uploadFile(ctx, target, bytes, options)`. It returns the created file and revision, or `{ ok: false, conflict }` with `stale-base` (the file changed since the edit's base revision) or `name-exists`. `uploadFile` never overwrites. Existing providers are unaffected: without `writeBack` a provider is read-only. `@ifc-lite/source-fixture` implements the contract (`capabilities.writeBack`, an `uploadFile` failure-injection key), and the conformance kit checks that `uploadFile` is present exactly when `writeBack` lists a mode. Part of #9522.
