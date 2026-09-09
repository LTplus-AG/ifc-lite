---
"@ifc-lite/viewer": patch
---

Fix `sdk.export.ifc()` (the scripting console, extension host, and BroadcastChannel bridge) still exporting the whole model when the hierarchy panel's Class tab filter is active and the caller passes the full entity set with `visibleOnly: true` — the same #4328 bug the dialog export paths were fixed for, reproduced on the SDK surface because its own filter resolver only read `hiddenEntitiesByModel`/`isolatedEntitiesByModel` and never `classFilter`, `selectedStoreys`, or `typeVisibility`. It now routes through the same `resolveExportVisibility()` resolver as ExportDialog/GLBExportDialog whenever the caller's refs cover the whole model; an explicit subset of refs is unaffected and still exports exactly what was named, regardless of visibility state.

Also fix the coverage check itself: "the caller's refs cover the whole model" was decided by cardinality alone (`refs.length` compared against the model's entity count), so a `refs` array sized to the model but made of ids that don't exist in it — or that merely isn't smaller than the model — was misclassified as "full model" and silently exported the whole model regardless of what the caller named. It's now a verified membership check: every id in `refs` must actually resolve to an entity in the model before it counts as a full-model export.
