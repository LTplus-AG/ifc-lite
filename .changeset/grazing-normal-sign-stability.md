---
"@ifc-lite/renderer": patch
---

Fix grazing-angle shading artifacts: diagonal lighter/darker bands on flat
walls and slabs, and dashed/broken separation lines along wall corners.

Root cause: the derivative-based flat-shading normal
(`cross(dpdx(worldPos), dpdy(worldPos))`) is numerically sign-unstable at
grazing view angles — the hemisphere-ambient and rim-light terms then
band-flip across large regions of a single flat surface (and on the 1–2 px
z-hash slivers along entity corners, which rendered as dark dashes). The
normal's direction is now kept from the screen-space derivatives (preserving
the coplanar-strip scar-line immunity) while its sign is stabilized by the
interpolated vertex normal, guarded against missing/near-perpendicular
vertex normals. The textured shader inherits the fix through its anchored
derivation.

The separation-lines pass additionally gained a per-axis second-difference
"crease" gate (3e-4 relative) alongside the existing 5e-4 first-difference
gate, so depth-continuous wall/wall and floor/wall seams draw consistently
instead of flickering around the threshold (dashed lines). Coplanar
continuations stay suppressed: their second difference is bounded by the
anti-z-fight hash offset (≤2.55e-4). No new texture loads; both changes are
a few ALU ops — verified flat 60 fps (0 frames >20 ms over 300 forced
full-effect renders) and zero load-time impact.
