---
'@ifc-lite/wasm': minor
---

Expose general 2D boolean operations over contour sets: `union2d`,
`difference2d`, `intersection2d`, `resolve2d` and the `Contours2D` handle they
operate on.

Until now the only `i_overlay` capability crossing the wasm boundary was the
fixed-purpose `meshOutline2d`, which unions one mesh's projected triangles into
a silhouette. Anything that needed to combine two silhouettes — analytic
hidden-surface removal, screen tiling, footprint overlap — had to bolt a second
2D geometry engine onto the same pipeline, with different winding, precision and
robustness semantics than the outlines it was consuming.

`Contours2D.fromMeshOutline(outline)` adopts a `meshOutline2d` result directly,
so an outline round-trips through a boolean without leaving the library.

The results keep **every** disjoint output shape with its holes, grouped via
`shapeOffsets()`. That is the difference from the internal `subtract_2d`, which
collapses to the largest shape — correct for the single extrusion profile it
serves, silent geometry loss for a difference that splits its subject into
islands (a wall seen past a column is two visible slivers, not one).

Winding is the contract: the fill rule is always NonZero and input winding is
respected rather than normalised. Because it is NonZero, winding is relative — a
counter-clockwise ring covers area, and a clockwise ring creates a hole only
where it cancels positive winding (a lone clockwise ring still fills). That
matches what `meshOutline2d` emits and what SVG `fill-rule="nonzero"` renders, so
holes survive a round trip. Callers holding raw, arbitrarily-wound contours that
all mean "covered" must normalise them CCW first.

Degenerate input is dropped, not fatal: rings under 3 vertices or carrying any
non-finite coordinate are discarded, an explicitly repeated closing vertex is
tolerated, and every empty-operand combination has a defined answer.

Resolves #1863.
