---
'@ifc-lite/renderer': patch
'@ifc-lite/viewer': patch
---

Make the section plane's in-plane basis continuous in the normal.

`planeBasis` picked its reference axis with `Math.abs(ny) < 0.9`, switching
from world-Y to world-X at that threshold. `|ny| = 0.9` is a plane 25.8 degrees
off horizontal — an ordinary ~6:12 roof pitch — and `setSectionPlaneFromFace`
reaches it from a face pick, so two picks on roof faces either side of that
pitch got bases that were nowhere near each other. Measured across the
boundary: at `nz = 0` the tangent inverted exactly (`dot = -1`, a 180-degree
flip); at `nz = 0.3` it was an arbitrary 133-degree rotation, the size of the
jump depending on `nz`; and it was asymmetric — the `ny < 0` crossing did not
move at all. Nothing pinned it: the existing test asserted only orthonormality,
which every rotation and sign flip of an in-plane basis satisfies.

That basis is the coordinate frame a face-picked drawing is generated in —
`useDrawingGeneration` hands `custom.tangent`/`custom.bitangent` to the cutter
as `customPlane`, and `drawing-generator` works in it — so the jump was a
drawing that came out rotated between two nearly identical picks. (The cap
hatch is screen-space and its 2D→3D round-trip uses one basis at both ends, so
it self-cancels; the module doc's stated victim was in fact immune.)

The threshold is gone. World-Y is now the reference for every normal except
exactly `±Y`, where the cross product genuinely vanishes; the tangent is
`normalize(normal × Ŷ)`, which depends only on the normal's azimuth and is
continuous over the whole sphere minus those two points. Continuity everywhere
is not available — the hairy-ball theorem forbids a nowhere-zero tangent field
on a sphere, so some normal has to be singular — and `±Y` is the cheapest place
for it: the plane is exactly horizontal there, so the drawing is a plan whose
in-plane rotation carries no meaning. At those two normals the historical basis
is kept unchanged, so a picked horizontal floor still reproduces the "Down"
preset's hatch orientation. The branchless Frisvad/Duff construction was
measured and rejected: its `copysign` variant is itself discontinuous across
`nz = 0` (`dot = -1` at `n = +X`), and pinning the singularity to one point
costs `bitangent · Y = -nx`, i.e. every elevation on half the sphere upside
down. The chosen field keeps `bitangent · Y = sin(tilt) >= 0` everywhere, so
face-picked elevations stay upright — which the old code did not manage either,
since its X-fallback pointed the bitangent downward for every `ny > 0.9`.

Behaviour change: for normals with `|ny| > 0.9` — near-horizontal planes,
including every horizontal-ish face pick except an exactly axis-aligned one —
the basis is different from before. A section drawing regenerated from such a
pick can come out rotated relative to one generated before this change, and a
saved section plane reloads with the new basis. Cardinal presets, exactly
axis-aligned picks (`±X`, `±Y`, `±Z`) and every normal with `|ny| < 0.9` are
bit-for-bit unchanged. No golden or snapshot moved: the renderer, drawing-2d
and viewer suites pass unmodified.
