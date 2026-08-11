---
"@ifc-lite/wasm": patch
"@ifc-lite/clash": patch
---

Add the `distanceKind` getter to `ClashRunResult` (`rust/wasm-bindings/src/api/clash.rs`) that `@ifc-lite/clash`'s wasm engine reads.

Without this changeset `@ifc-lite/clash` would publish depending on `@ifc-lite/wasm: workspace:^`, which npm can satisfy with a pre-existing `@ifc-lite/wasm` build that lacks the getter — `wasm-kernel.ts` would then read `undefined` off the result and throw reading an out-of-range index, on the first clash. This bumps `@ifc-lite/wasm` alongside `@ifc-lite/clash` so the published dependency range only ever resolves to a build that has the field.
