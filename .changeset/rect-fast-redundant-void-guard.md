---
"@ifc-lite/geometry": patch
---

Fix the rectangular-opening fast path erasing whole walls on redundant voids.

Some authoring tools bake an opening into the wall profile AND re-add it as a
separate opening element whose box spans the entire wall (a double-encoded /
redundant void). The exact CSG kernel treats such a cutter as a no-op (its faces
are coplanar with the host, so the host is returned unchanged), but the analytic
`rect_fast` path was cutting it literally — removing the entire wall and leaving
the window floating in a giant void (#1167).

`rect_fast` now detects any opening whose clamped box contains the whole host on
all three axes and defers the element to the exact kernel, matching its
behaviour. Genuine interior openings (a margin on any in-face axis) are
unaffected and still cut analytically. Verified against ~1,500 void elements
across 13 architectural models: the only fast-vs-exact divergence was this
whole-wall case, now gone; every normal window already removed identical volume
on both paths.
