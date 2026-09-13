---
"@ifc-lite/server-bin": patch
---

`IgnoreOpaque` now suppresses an opaque door or window that also carries a representation the geometry router does not mesh. The filter walked every representation of the product, so an unstyled item in a `Box` or `Axis` representation, or in a `MappedRepresentation` that direct body geometry makes redundant, counted as a part that takes a transparent material colour, and the door was kept even though every part it renders is opaque. The filter now selects representations through the router's own rule, exposed from `ifc-lite-geometry` as `meshed_representations`.
