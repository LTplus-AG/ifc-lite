---
"@ifc-lite/create": patch
"@ifc-lite/sdk": minor
"@ifc-lite/viewer": patch
---

`@ifc-lite/create` and `@ifc-lite/sdk` now declare `sideEffects` (#9200), so bundlers can drop the modules an app imports through the package index but never uses. `@ifc-lite/create` declares `false`. `@ifc-lite/sdk` names only its index: loading it registers the parser's schema check with `@ifc-lite/mutations`, which must still run whenever the SDK loads.

New in `@ifc-lite/sdk`: `createModellingStoreBackendWithoutStoreys(resolve)` builds every modelling method except the storey ones (type `ModellingStoreBackendMethodsWithoutStoreys`), for a host that supplies its own storey methods. A bundle that calls only this factory leaves the storey planners out. `createModellingStoreBackend` is unchanged: it is that factory plus `createStoreyStoreBackend`.

The viewer builds its startup modelling methods with the new factory, because its `bim.store` storey methods already come from its own history-tracked storey adapter, which loads on first use. It also keeps the QuickJS runtime core out of its eager `sandbox` chunk; the runtime now loads with the first script run. Nothing changes at runtime.
