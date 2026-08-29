---
'@ifc-lite/geometry': patch
---

The synchronous WASM mesh path (`processAdaptive`'s <2MB branch, via `collectMeshesViaPrePass`) now honours a caller-supplied `sharedRtcOffset` for federation alignment, matching the parallel and streaming paths (`geometry-parallel.ts`'s `useSharedRtc`).

Previously only the parallel and streaming WASM paths threaded a caller-supplied `sharedRtcOffset` through to the mesh pass; the sync path silently ignored it and always used the model's own detected RTC offset, so a small (<2MB) federated model rendered at its own origin instead of the shared federation origin its siblings use. `applyPrePassMetadata` and `collectMeshesViaPrePass` now accept an optional `sharedRtcOffset` and, when present, use it (with `needsShift` forced `true`) in place of the pre-pass's own detected offset — the same rule already applied by the parallel/streaming paths.

With #3455 having done the same for the single-threaded streaming fallback, all three WASM branches of `processAdaptive` now honour the federation origin; the native/Tauri path (`geometry-native.ts`) still does not.

No performance impact: same code path runs either way, only which RTC offset value is selected changes.
