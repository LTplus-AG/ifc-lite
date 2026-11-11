---
"@ifc-lite/parser": minor
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
---

Derive a structural analysis model from the physical one (#9668). Beams, columns and members become curve members on their axis; slabs and walls become surface members on their mid-plane; member ends within a tolerance (default 0.05 m) share a node; footings and piles carry supports, or the lowest nodes do when no footing exists, flagged as guessed. Every member and node is linked to its physical element with `IfcRelAssignsToProduct`, and elements that already have a structural counterpart are skipped, so a second run writes nothing. `@ifc-lite/create` exports the three steps (`readStructuralDerivationFacts`, `planStructuralDerivation`, `applyStructuralDerivation`); scripts call `bim.store.planStructuralDerivation` and `bim.store.deriveStructuralAnalysisModel`; the CLI adds `ifc-lite derive-structural`. Works on IFC2X3, IFC4 and IFC4X3. `@ifc-lite/parser` exports `effectiveStructuralView(store, view)`, the one adapter from an editable overlay to the structural read model, now shared by the viewer and the derivation.
