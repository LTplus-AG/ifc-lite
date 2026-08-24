---
"@ifc-lite/parser": patch
---

Stop dropping six concrete IFC2X3 products from mesh and attribute export, and remove an alias row that named no entity.

`rust/core/src/legacy_entities.rs` is the table every classification pass is told to consult instead of a bare `IfcType::from_str`. It held 21 arms. Diffing `@ifc-lite/data`'s IFC2X3/IFC4 tables against the generated IFC4X3 enum — the method `merged.rs` already documents — turns up six concrete `IfcProduct` subtypes that carry both a placement and a representation and were in neither: `IfcElectricalElement`, `IfcElectricDistributionPoint`, `IfcChamferEdgeFeature`, `IfcRoundedEdgeFeature`, `IfcStructuralLinearActionVarying`, `IfcStructuralPlanarActionVarying`.

A name the table misses resolves to `IfcType::Unknown`, and `Unknown` is a subtype of nothing. The attribute exporter keeps a row only if the type reaches `IfcProduct`, and `has_geometry_by_name` refuses `Unknown` outright, so an IFC2X3 file containing one of these lost it from the attribute export and from meshing at once. The two passes agreed, on dropping it — which is why nothing looked wrong. Each new arm maps to its own supertype from the older schema rather than to a generic proxy.

The `IfcElectricDistributionPoint` arm was spelled `IFCELECTRICALDISTRIBUTIONPOINT`, with an "AL" no IFC2X3 entity has. It could never match a real file, and a Rust test asserted `has_geometry_by_name` on the same misspelling, so the table and its test certified each other while describing nothing.

That misspelling had spread. #2883 mirrored it into `@ifc-lite/parser`'s `ENTITY_NAME_ALIASES` on the stated premise that it was "real, deprecated IFC2X3 syntax", and two tests plus a comment in `@ifc-lite/query` were then written against the mirror — five artifacts agreeing with each other about an entity that does not exist. The alias row is removed rather than respelled, because the correctly spelled name is in `ENTITIES_IFC2X3` and already resolves through `IfcFlowController` to `IfcDistributionElement` with no alias at all; that is also exactly what the new Rust arm answers. The dependents now assert the real name, plus a negative on the misspelling so restoring the alias turns them red.

Fixing the table exposed a second live defect. The construction-projection filter from #979 read `entity.ifc_type`, which the decoder fills with a bare `from_str` — so every legacy spelling of a feature element arrived as `Unknown` and passed straight through. Measured on AC20-FZK-Haus with its 17 openings respelled to `IFCOPENINGSTANDARDCASE`: 33 spurious void cross-sections in the floor plan before, none after.

`scripts/check-legacy-entity-coverage.mjs` now runs that diff on every PR, in both directions: a concrete legacy product with no arm fails, and so does an arm whose key names no entity in any bundled schema.
