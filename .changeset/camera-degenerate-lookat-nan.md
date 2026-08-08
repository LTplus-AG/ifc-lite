---
"@ifc-lite/renderer": patch
---

Fix a camera pose that made the entire view-projection matrix NaN, so the viewport rendered nothing.

`MathUtils.lookAt` had no degenerate-up guard: when the view direction is parallel to `up`, `cross(up, viewDir)` is exactly zero and normalizing it wrote NaN into all sixteen components. Nothing threw — the viewport just went blank. It now falls back to a stable basis built from whichever world axis is least aligned with the view direction, and likewise returns a finite matrix when `up` is zero-length or `eye` coincides with `target`. Well-conditioned poses are byte-identical to before.

Three routes reached that pose. The load-path one needed a second fix: `pickFitPolicy`'s linear branch applied its 20-degree downward tilt around world Y, the same axis it was tilting *from*, so for a Y-dominant bounding box the tilt cancelled and the view direction came back exactly parallel to the policy's own up vector. Any tall thin model past the linear gates (aspect > 50, longest >= 100 m) — a mast, chimney, shaft, lift core or turbine tower — auto-fitted to a dead viewport with no user action. Those now tilt away from a genuinely perpendicular axis. The other two routes, an exact overhead pose via `setPosition`/`setTarget` and an externally authored BCF viewpoint restore, are covered by the `lookAt` guard.

No exported surface change: both functions keep their signatures, and only degenerate inputs behave differently.
