---
"@ifc-lite/create": patch
---

Fix `resolveSpatialAnchor`'s four `store.source` guards (#2345): `IfcDataStore.source` is a mandatory accessor object, never `null`/`undefined` — even a source-less store carries `EMPTY_SOURCE_BYTES` — so a plain `if (store.source)` / `if (!store.source)` truthiness check was always true and never actually detected the "no source bytes" case it was written for. Replaced with an explicit `byteLength` check.

No behavior change for real callers: every current call site passes a store this same process just parsed, which always has resident source bytes. Verified with a synthetic empty-source store that the function still fails closed (throws) rather than silently misresolving, in both the old and the new code.
