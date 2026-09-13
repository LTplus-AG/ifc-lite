---
"@ifc-lite/wasm": patch
"@ifc-lite/server-bin": patch
---

Generate `rooted_type::LEGACY_ROOTED_TYPES` (which entity names IFC4X3 dropped or renamed but that carry a GlobalId in IFC2X3/IFC4) instead of hand-keeping it.

`rust/export/src/rooted_type.rs`'s own doc comment already said this 54-name list was "independently re-verified ... by walking each name's parent chain ... re-verify the same way (or regenerate from a diff of those three tables) rather than editing this list ad hoc." `scripts/generate-legacy-rooted-types.mjs` (#4203) now performs exactly that diff: it walks the same EXPRESS-derived `@ifc-lite/data` IFC2X3/IFC4 entity tables `scripts/generate-legacy-attribute-names.mjs` already reads, keeping a name whose parent chain reaches `IfcRoot` and that `rust/core/src/generated/schema.rs`'s `from_str` cannot resolve, and writes `rust/export/src/generated/legacy_rooted_types.rs`. The generated list is byte-identical to the hand-kept one it replaces (54 names, 0 conflicts between IFC2X3 and IFC4) — a pure provenance change, not a behavior change. `rooted_type::LEGACY_ROOTED_TYPES` keeps its path and shape (`&[&str]`), now re-exported from the generated module rather than defined inline; every existing caller (`is_rooted_type`, `rooted_type_parity.rs`'s cross-language fixture, `dump_rooted_type_sweep.rs`) is unaffected.

This is one slice of #4203 (generate the Rust type universe from EXPRESS, not by hand); `rust/core/src/legacy_entities.rs`'s base-type mapping and a per-schema-version `IfcType`/`from_str` are unchanged and not attempted here — see the PR description for what remains.
