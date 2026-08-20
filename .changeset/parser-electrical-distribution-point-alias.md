---
'@ifc-lite/parser': patch
---

Resolve `IfcElectricalDistributionPoint`'s inheritance chain in the TS parser.

`IfcElectricalDistributionPoint` is deprecated IFC2x3 syntax that no bundled
schema table (`ENTITIES_IFC2X3`/`IFC4`/`IFC4X3`) carries as a class — none has
an entry for it at all. `rust/core/src/legacy_entities.rs` handles this by
name ("IFC2x3 names that have no IFC4x3 enum variant") and resolves it to
`IfcDistributionElement`. `ifc-schema.ts`'s `ENTITY_NAME_ALIASES` table
carries a comment claiming it "mirrors `rust/core/src/legacy_entities.rs` so
the two sides stay in lockstep", but only ported the three IFC4.3 stratum
leaves — this entity, and 16 other Rust-side legacy names, were never added.
Of those, only this one is a real gap: the other 16 (`IfcBeamStandardCase`,
`IfcWindowStyle`, `IfcProxy`, ...) already resolve directly, since they exist
in `ENTITIES_IFC4`.

Before this change, `getInheritanceChain('IfcElectricalDistributionPoint')`
returned `[]` in the TS parser while the Rust core resolved the same entity
name to `IfcDistributionElement` with geometry — a real cross-language
divergence on a legal (if deprecated) STEP entity. `ENTITY_NAME_ALIASES` now
carries the same mapping, so `getInheritanceChain` includes
`IfcDistributionElement` for this class, matching the Rust core.
