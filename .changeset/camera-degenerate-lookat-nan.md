---
"@ifc-lite/renderer": patch
---

Fix a camera pose that made the entire view-projection matrix NaN, so the viewport rendered nothing.

`MathUtils.lookAt` had no degenerate-up guard: when the view direction is parallel to `up`, `cross(up, viewDir)` is exactly zero and normalizing it wrote NaN into all sixteen components. Nothing threw — the viewport just went blank. It now substitutes an up hint that carries real orientation, and likewise returns a finite matrix when `up` is zero-length, when `eye` coincides with `target`, and when any input coordinate is non-finite (a malformed viewpoint read from a file reaches the public camera setters unvalidated). The camera's own near/far derivation is guarded the same way, in both projection modes, so a non-finite pose cannot reach the projection matrix either. Well-conditioned poses are byte-identical to before.

Three routes reached that pose. The load-path one needed a second fix: `pickFitPolicy`'s linear branch applied its 20-degree downward tilt around world Y, the same axis it was tilting *from*, so for a Y-dominant bounding box the tilt cancelled and the view direction came back exactly parallel to the policy's own up vector. Any tall thin model past the linear gates (aspect > 50, longest >= 100 m) — a mast, chimney, shaft, lift core or turbine tower — auto-fitted to a dead viewport with no user action. Those now tilt away from a genuinely perpendicular axis. The other two routes, an exact overhead pose via `setPosition`/`setTarget` and an externally authored BCF viewpoint restore, are covered by the `lookAt` guard.

No exported surface change: every function keeps its signature, and only degenerate inputs behave differently.
