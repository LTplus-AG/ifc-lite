---
"@ifc-lite/sdk": minor
"@ifc-lite/physics": minor
"@ifc-lite/data": minor
"@ifc-lite/parser": minor
"@ifc-lite/cache": patch
"@ifc-lite/export": patch
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
colorize falling=red, tilted=orange, anchored=blue, plus a persistent
floating panel summarizes the run with re-run/reset controls.

A native CLI binary `ifc-lite-physics` is also available (built from
the `ifc-lite-engine` crate) for terminal use:
`ifc-lite-physics model.ifc --remove 42 --json`.

The relationship parser now extracts `IfcRelConnectsStructuralMember`
and `IfcRelConnectsWithRealizingElements` in addition to
`IfcRelConnectsElements` / `IfcRelConnectsPathElements`; structural-
domain models with explicit member-to-connection edges now feed those
into the physics joint graph automatically.

A new `colliderStrategy` option (`'auto' | 'trimesh' | 'convexHull'`)
controls how meshes become colliders. The `auto` default — applied to
both Rust and JS runtimes — picks convex hulls for columns / beams /
members / footings / piles / plates (faster + more contact-stable) and
falls back to trimesh for slabs / walls / roofs that routinely have
openings.

See `docs/guide/physics.md` for the full guide.

This is a plausibility check, not structural engineering: no bending,
buckling, or material yield. Real analysis still belongs in an FEM tool
fed via `IfcStructuralAnalysisModel`.
