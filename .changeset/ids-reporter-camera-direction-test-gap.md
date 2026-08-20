---
'@ifc-lite/bcf': patch
---

Harden the IDS→BCF reporter's camera-direction test so a sign-flipped viewpoint camera can't pass silently.

`computeCameraFromBounds` (`ids-reporter.ts`) places the BCF viewpoint camera
off-center and points it back at the failing entity. The only test covering
that direction, `should point camera toward entity center`, checked just
`Math.sqrt(x²+y²+z²) ≈ 1` — true for *any* unit vector, including one
pointing the camera at empty space away from the entity. Reversing the
`dx/dy/dz` sign in `computeCameraFromBounds` (camera looking away from the
entity instead of at it) left all 48 `ids-reporter.test.ts` tests green.

The test now asserts `cameraDirection` equals the normalized vector from the
(converted) camera position to the (converted) entity center, so a reversed
sign fails. No production code changed — `computeCameraFromBounds` already
computes the correct direction; this closes the fixture gap that couldn't
have caught a regression there. Confirmed by mutation: reversing the sign in
`computeCameraFromBounds` now fails the new assertion; reverting restores 48/48.
