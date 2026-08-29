---
'@ifc-lite/geometry': patch
---

Thread a federated `sharedRtcOffset` through the single-threaded WASM streaming fallback, so it stops misaligning a model that lands there.

`processAdaptive` picks a `sharedRtcOffset` from the earliest-loaded model so every federated model renders in one coordinate space, and threads it correctly through `processParallel` (`sendStreamStartIfReady`'s `useSharedRtc` override). `GeometryProcessor.processStreaming` accepted the same parameter but silently dropped it: `processStreamingBytes` always used the pre-pass's own per-model RTC detection instead, contradicting the very comment beside its call site ("Infrastructure models with large coordinates are always >2MB and use the parallel/streaming paths where shared RTC is properly threaded" — the single-threaded streaming path is one of those "properly threaded" paths in name only).

This path is not a corner case: `processAdaptive` falls back to it for any file at or above the 2MB threshold whenever `useParallel` is false — no `SharedArrayBuffer`/`Worker` support, or `navigator.hardwareConcurrency <= 1` — which includes any deployment missing cross-origin-isolation headers. A federated model that happened to load through that fallback would compute its own RTC origin and render offset from the rest of the federation instead of aligning with it.

`processStreamingBytes` now mirrors `processParallel`'s override exactly: a caller-supplied `sharedRtcOffset` replaces the pre-pass's `rtcX`/`rtcY`/`rtcZ` and forces `needsShift`, in the `processGeometryBatch` calls, the emitted `rtcOffset` event, and the coordinate handler's metadata. The synchronous `<2MB` path (`processAdaptive`'s sync branch, `collectMeshesViaPrePass`) is unaffected — it remains a documented, separate limitation.
