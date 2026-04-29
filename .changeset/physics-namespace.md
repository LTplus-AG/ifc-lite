---
"@ifc-lite/sdk": minor
"@ifc-lite/physics": minor
---

Add `bim.physics` namespace and a new `@ifc-lite/physics` package for
rigid-body what-if simulation ("if I remove this column, will anything
fall?"). Backed by Rapier — the Rust `ifc-lite-physics` crate for native
hosts (server, desktop), and `@dimforge/rapier3d-compat` for the
browser/Node viewer. Single model only in v1.

`SimulateOptions` accepts an optional `connections` list of express-id
pairs; the viewer adapter populates this automatically from
`IfcRelConnectsElements` and `IfcRelConnectsPathElements`, so welded
elements that don't share an AABB still hold each other up. Joints
preserve current relative pose instead of yanking origins together.

`bim.physics.ready()` resolves once the engine has finished
bootstrapping (Rapier WASM init in the browser/Node case, no-op
otherwise). The viewer's right-click menu now exposes "What if I
remove this? (Physics)" and a "Reset physics colors" action; results
colorize falling=red, tilted=orange, anchored=blue, with a toast
summary.

This is a plausibility check, not structural engineering: no bending,
buckling, or material yield. Real analysis still belongs in an FEM tool
fed via `IfcStructuralAnalysisModel`.
