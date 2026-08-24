---
"@ifc-lite/geometry": minor
"@ifc-lite/export": patch
---

Name the `geometryClass` ordinals once, in a new `@ifc-lite/geometry/geometry-class` entry point.

Every mesh carries a `geometryClass` tag decided in Rust and read here: 0 occurrence, 1 orphan type, 2 instanced type, 3 material-layer slice. It crosses the WASM boundary as a bare `u8`, so nothing in the type system connects the two sides — and until now the TypeScript half compared against bare integers in five files across three packages (`type-view-visibility.ts`, `kmz-exporter.ts`, `GLBExportDialog.tsx`, `demesh-session.ts` and `geometry/src/index.ts`). Renumbering a class meant finding all five, and missing one was silent: geometry is reclassified, not rejected, so a layered wall drops out of Model view or a type-library duplicate renders as real building geometry with nothing thrown.

The new module exports the four ordinals, a `geometryClassOf(mesh)` reader carrying the `?? 0` default every call site already applied, and the two predicates the visibility rule is built from. All five call sites now go through it, with no behaviour change — the comparisons are the same, spelled differently.

What this does **not** do is check the values against Rust; it pins the TypeScript half only. Closing the other half needs an assertion at the real boundary — loading a layered-wall fixture through WASM in `scripts/test-wasm-contract.mjs` and asserting the emitted class. That script already reads `geometryClass`, but only inside `meshFingerprint()` for a both-code-paths-agree check, which any value satisfies as long as both sides produce the same one. The new test file says so explicitly rather than implying more coverage than exists.
