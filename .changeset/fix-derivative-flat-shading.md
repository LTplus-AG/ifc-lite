---
"@ifc-lite/renderer": minor
---

ROOT-CAUSE fix for visible triangulation / scar lines on flat surfaces
after every CSG operation (opening subtraction, layer slicing). Switch
the main fragment shader from interpolated vertex normals to
derivative-based flat shading for the lit normal, matching the
industry standard for BIM/CAD viewers (Three.js
`material.flatShading`, Autodesk Forge, Speckle, xeokit).

### Why this is the right fix

The visible "horizontal striations on walls", "stripes on slabs",
"triangulation lines" the user reports across the legacy BSP kernel
AND the Manifold kernel all come from one thing: per-vertex normal
averaging on a mesh whose strip-boundary vertices carry slightly
different f32 positions / normals coming out of the CSG. CPU-side
welding + crease-aware smoothing (the previous attempts on PR #861)
helps but never fully eliminates it — any per-vertex normal can carry
sub-ulp noise that the rasteriser amplifies into a visible line at
strip boundaries.

`cross(dpdx(worldPos), dpdy(worldPos))` evaluates to the EXACT face
normal in the fragment shader. Every fragment on a flat face — across
an arbitrarily-fine triangulation — gets the IDENTICAL normal, so
coplanar splits become invisible by construction. The CSG kernel can
emit as many strip triangles as it wants; the rendered surface looks
like one continuous face.

### Trade-off

Genuinely curved surfaces (cylinder tessellations, BSpline
approximations) shade with visible facets at the triangle resolution
the IFC author chose. For BIM that's acceptable — curved surfaces are
< 5 % of typical model triangle count and the faceting matches
Revit / ArchiCAD on-screen behaviour at default quality. Future work
could add a per-primitive smooth-shading flag for explicit smooth
surfaces; until then, flat-by-default is correct for the dominant case.

### Secondary fix

The edge-enhancement pass also switched from interpolated-vertex-normal
gradient to face-normal gradient. Without that change the edge
enhancer would draw the same false dark stripes from vertex-normal
noise — only the LIT normal would be clean. Now both light and edge
agree: coplanar adjacent triangles produce zero gradient → no spurious
edge; real wall-meets-floor creases produce a large gradient → the
intended outline.

### Verification

`pnpm --filter @ifc-lite/renderer build` typechecks clean. The fix is
a shader-only change to `packages/renderer/src/shaders/main.wgsl.ts`;
no Rust or test changes required. Visual verification on deploy
preview required — load any model that previously showed scar lines
(BIMcollab Example, ifc4 walls with openings, etc.).
