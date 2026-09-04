---
'@ifc-lite/server-client': patch
'@ifc-lite/geometry': patch
---

Type-only fix: `ParseResponse.geometry_diagnostics` no longer points at a stale copy of `GeometryDiagnostics`. The copy had missed `schemaVersion`, `worstHosts.bbox`, `worstHosts.triangleCount` and `oversizedRefDrops`, all of which the Rust server serialises, so reading one meant a type error and a cast. A compile-time contract test now compares the client's copy with the canonical type in `@ifc-lite/geometry` field for field, so the two cannot drift again.

`@ifc-lite/server-client` keeps its empty `dependencies` map: no dependency on `@ifc-lite/geometry` was added, and the runtime is untouched.

`@ifc-lite/geometry` gains `GeometryDiagnostics.oversizedRefDrops` (optional) and sums it in `mergeGeometryDiagnostics`. The Rust pass has emitted the counter since #3752; no TypeScript consumer could read it, and the merge dropped it on every fold.

The client copy also declares `totalUnsupportedItems` / `unsupportedItemsByType` ahead of the canonical type so that PR #3691, which adds those two fields in `@ifc-lite/geometry`, does not collide with this change. The contract test allowlists exactly those names and fails once #3691 lands, which is the signal to delete the allowlist entry.

The Rust producer now omits `worstHosts.firstFailureLabel`, `worstHosts.bbox` and `worstHosts.triangleCount` from the JSON when they are `None`, instead of writing an explicit `null`. The TypeScript mirrors declare them as `field?: T`, which means the key is absent; the wasm boundary already matched that because `serde_wasm_bindgen` writes `None` as `undefined`, but the server response goes through `serde_json`, which wrote `null`. A consumer guarding with `!== undefined` typechecked and then threw. Deserialisation is unchanged: a missing key and an explicit `null` both read back as `None`, so older payloads still parse.
