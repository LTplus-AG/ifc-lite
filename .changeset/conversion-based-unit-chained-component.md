---
'@ifc-lite/wasm': patch
---

Fix `ProjectUnits` resolving a conversion-based unit whose `ConversionFactor.UnitComponent` is itself a conversion-based unit (a real-world chain, e.g. `YARD` defined as 3 `FOOT` where `FOOT` is 0.3048 metre) or a derived unit, rather than a bare/prefixed `IfcSIUnit`.

`IfcMeasureWithUnit.UnitComponent` is typed `IfcUnit` — any `IfcNamedUnit` or `IfcDerivedUnit`, not just `IfcSIUnit` — but `conversion_factor_scale` (`rust/core/src/project_units/mod.rs`) only recognised a plain `IFCSIUNIT` component and silently fell back to a component scale of `1.0` for anything else. For the YARD/FOOT chain this resolved `si_scale` to `3.0` instead of the spec-correct `0.9144`, a ~3.3x error with no error reported — the unit still resolved, just to the wrong magnitude. The fix resolves the `UnitComponent` through the same recursive `resolve_unit_by_ref_depth` dispatcher already used for `IFCDERIVEDUNIT` elements, so a chained conversion-based (or derived) component composes correctly; the existing SI and prefixed-SI-component cases are unchanged (both already covered by tests).

This is `ifc-lite-core`'s `ProjectUnits` resolver, exported from the crate for `@ifc-lite/wasm` consumers; it has no in-tree Rust caller yet (no CLI/server path wires it up today). The parallel TypeScript resolver (`packages/parser/src/project-units.ts`) has the identical gap but is out of scope here — it is the target file of two other in-flight PRs.
