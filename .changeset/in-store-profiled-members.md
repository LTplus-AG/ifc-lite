---
"@ifc-lite/create": minor
---

`addBeamToStore`, `addColumnToStore` and `addMemberToStore` take an optional `Profile` (#6232): I, L, T, U, C, circle, rectangular hollow or circular hollow, built by the new shared `emitProfileSection` factory. The Width x Height (or Width x Depth) rectangle stays the default, so existing callers are unchanged. The profile's attributes are laid out for the anchor's schema (IFC2X3, IFC4, IFC4X3), and IFC5 is refused.
