---
'@ifc-lite/geometry': patch
---

Fix `IfcExtrudedAreaSolidTapered` (lofted extrusion) hole side walls shading with inverted normals. `create_lofted_side_walls` applied a `winding_sign` correction (matching `create_side_walls`'s convention, which already leaves a CW-authored hole's walls facing into the void) and then flipped the normal a second time for `is_hole`, pointing hole side walls out of the void instead of into it — any tapered element with an opening (a tapered wall or column with a window/duct penetration) would shade its opening reveal inside-out. Removed the redundant second flip; a new regression test compares the untapered (`start == end`) lofted case directly against uniform `extrude_profile`'s hole normal and requires them to agree.
