---
"@ifc-lite/clash": minor
"@ifc-lite/wasm": minor
---

Whether a reported clash counts as "touching" no longer depends on where the model sits in world space.

`isTouching` (used by the viewer's "hide touching" filter) treats a `hard` clash as a contact when its depth is within a band. That band came from the largest absolute coordinate of the clash's bounds over all three axes, times 2^-22, so a model 10 km out along X gave a vertical contact about 2.4 mm of slack from the X coordinate alone. A genuine 1 mm overlap was listed as a clash at the origin and hidden as "touching" 10 km away.

Every `hard` clash now carries `depthFloor`: the float32 noise floor of its own depth along the direction that depth was measured, which is the same floor the engine classified it against (defined once in the shared clash-math source, identical in the TypeScript and Rust/WASM kernels). `isTouching` uses `max(TOUCHING_EPSILON, depthFloor)` as its default band, so reporting and classification follow one rule. An explicit `eps` still overrides it.

`Clash.depthFloor` is a new optional field, set on every `hard` clash and absent on every other status. A clash without it — recorded before this release, rehydrated from BCF or JSON without it, or built by hand — keeps the previous band unchanged. The WASM `ClashRunResult` gains a `depthFloor` getter (NaN for non-hard records), and the Rust `ClashSession` gains `run_rule_with_depth_floors`; `run_rule` and `ClashRecord` are unchanged.
