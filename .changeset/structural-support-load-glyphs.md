---
"@ifc-lite/parser": minor
"@ifc-lite/viewer": minor
"@ifc-lite/embed-protocol": minor
"@ifc-lite/embed-sdk": patch
---

The viewer draws the supports and loads of a structural analysis model (#9668). Point, curve and surface connections with a restraining boundary condition show a fixed, pinned, roller or spring support symbol; actions show force arrows (one per point, a row along a member, a sparse grid over a face), moment arrows, and temperature and displacement markers. Symbols keep their screen size, capped at 3% of the model diagonal, but never below 0.25 m. Clicking one selects its connection or activity. The "Supports & loads" switch in the class visibility menu turns them off.

`@ifc-lite/parser/structural-glyphs` exports `structuralGlyphs(store, extraction)`, which returns the glyph list as plain data in IFC world metres: kind, position, direction, magnitude, the size relative to the largest load of its kind in its load group, and the source entity. It is a subpath of its own so the viewer loads it only for a model with structural data.

Embed hosts reach the same switch as the `structuralGlyphs` flag of `SET_TYPE_VISIBILITY` (`TYPE_VISIBILITY_FLAG_KEYS`).
