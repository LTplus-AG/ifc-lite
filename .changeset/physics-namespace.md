---
"@ifc-lite/sdk": minor
"@ifc-lite/physics": minor
---

Add `bim.physics` namespace and a new `@ifc-lite/physics` package for
rigid-body what-if simulation ("if I remove this column, will anything
fall?"). Backed by Rapier — the Rust `ifc-lite-physics` crate for native
hosts (server, desktop), and `@dimforge/rapier3d-compat` for the
browser/Node viewer. Single model only in v1.

This is a plausibility check, not structural engineering: no bending,
buckling, or material yield. Real analysis still belongs in an FEM tool
fed via `IfcStructuralAnalysisModel`.
