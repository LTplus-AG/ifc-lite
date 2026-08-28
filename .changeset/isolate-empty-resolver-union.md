---
'@ifc-lite/viewer-embed': patch
'@ifc-lite/viewer': patch
---

Fix every `isolateEntities`/`setIsolatedEntities` call site routed through `cameraCallbacks.resolveHighlightIds` (the embed bridge's `ISOLATE` command, `?isolate=` URL params, IDS row/set isolation, the BCF viewpoint isolation mode, and the anonymized-export preview) falling back only when the resolver is absent, not when it runs and returns `[]`.

`resolver?.(ids) ?? ids` catches a missing resolver but not an empty result. `resolveHighlightIds` returns `[]` whenever geometry has not finished streaming yet or every id resolves geometry-less, and isolating an empty set hides the entire model until the isolation is cleared — it does not self-heal once geometry arrives. Each site now unions the resolved ids with the raw ones (`[...new Set([...resolved ?? [], ...raw])]`), matching the pattern LensPanel and PropertiesPanel already used.
