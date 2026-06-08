---
"@ifc-lite/wasm": patch
---

Fix inside-out shading on extruded solids whose outer profile is authored counter-clockwise (e.g. the AC20-FZK-Haus roof slab). `create_side_walls` stored the inward in-plane normal regardless of the loop winding, so under the renderer's normal-based, double-sided lighting the side faces shaded as if lit from inside. The side-wall normal is now oriented outward via the profile's signed area, so it agrees with the (already-outward) triangle winding. CW outer loops and holes are byte-identical to before; caps were already winding-independent. The tapered (`IfcExtrudedAreaSolidTapered`) path is oriented the same way for consistency.
