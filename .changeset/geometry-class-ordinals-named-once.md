---
"@ifc-lite/geometry": minor
"@ifc-lite/export": patch
---

Name the `geometryClass` ordinals once, in a new `@ifc-lite/geometry/geometry-class` entry point.

Every mesh carries a `geometryClass` tag decided in Rust and read here: 0 occurrence, 1 orphan type, 2 instanced type, 3 material-layer slice. It crosses the WASM boundary as a bare `u8`, so nothing in the type system connects the two sides — and until now the TypeScript half compared against bare integers in six files across three packages (`type-view-visibility.ts`, `kmz-exporter.ts`, `GLBExportDialog.tsx`, `ViewportContainer.tsx`, `demesh-session.ts` and `geometry/src/index.ts`). Renumbering a class meant finding all six, and missing one was silent: geometry is reclassified, not rejected, so a layered wall drops out of Model view or a type-library duplicate renders as real building geometry with nothing thrown.

The new module exports the four ordinals, a `geometryClassOf(mesh)` reader carrying the `?? 0` default every call site already applied, and the two predicates the visibility rule is built from. All six call sites now go through it, with no behaviour change — the comparisons are the same, spelled differently.

Both halves of the contract are now pinned. The TypeScript side asserts the ordinals are distinct and that placed / type-library partition them, and `scripts/test-wasm-contract.mjs` asserts what Rust **actually emits** across the WASM boundary — a layered-wall fixture must produce class 3 alongside class 0, so the ordinals cannot be renumbered on the Rust side without a test failing.

That second half matters because the script's existing `geometryClass` read lives inside `meshFingerprint()`, comparing two code paths against each other — satisfied by any value provided both sides agree, which is a self-round-trip rather than a pin. The occurrence-class assertion is there so that a build tagging *everything* 3 would fail too, instead of passing the layer-slice check.
