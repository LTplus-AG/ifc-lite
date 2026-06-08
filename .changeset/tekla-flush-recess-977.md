---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

fix(geometry): cut tilted/profile-section openings with the real mesh (#977)

Openings on tilted steel members (Tekla channels, tubes, I-beams, gusset plates)
were cut by the analytic axis-aligned-box clip. The AABB of a tilted thin cutter
is far larger than the authored cutter, so it over-cut — removing real section
material and leaving a thin residual wall — and the analytic path also fabricates
reveal/cap walls in the open profile. This was a project-wide error on every
tilted member.

Openings are now routed by a **type-independent geometric test**: when an
opening's world AABB volume significantly exceeds its actual cutter-solid volume
(i.e. the cutter is tilted or non-box), it is cut with its **real mesh** via the
Manifold boolean — exact authored shape, no bounding-box inflation, and the
kernel's perturbation clears coplanarity with the profile's inner faces/fillets.
Axis-aligned box openings (AABB ≈ cutter) keep the cheap, deterministic analytic
clip, so flat slab/wall openings stay stable on CI. Because the test is geometry-
not type-based, it works regardless of how an exporter labels elements (incl.
projects that model everything as IfcBuildingElementProxy).

Also retunes the Manifold cutter perturbation to clear the kernel's host-relative
coplanarity tolerance.
