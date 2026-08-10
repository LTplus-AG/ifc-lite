---
"@ifc-lite/renderer": minor
---

Export `viewBasis`, the orthonormal camera basis `MathUtils.lookAt` renders through.

`lookAt` has always resolved a degenerate `up` — parallel to the view direction, zero-length, or non-finite — by substituting a deterministic hint, so a plan view still renders a well-conditioned frame. That substitution was only observable inside the package, which left any consumer that has to reconstruct the on-screen basis from `getPosition()` / `getTarget()` / `getUp()` recomputing `cross(forward, up)` itself and inventing a different answer for the same degenerate pose. #2467 removed one such duplicate inside the package; the Cesium map overlay is the same situation from outside it, and a second answer there means the basemap is rotated against the model precisely in the plan view the overlay is most used in.

Pure addition: no existing export changes shape or behaviour.
