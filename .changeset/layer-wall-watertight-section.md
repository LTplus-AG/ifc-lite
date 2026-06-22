---
"@ifc-lite/drawing-2d": patch
---

Reconstruct per-layer section fills from open (cap-free) material-layer bands. The geometry slicer no longer caps the layer interface planes — capping doubled each shared interface into a coincident, non-watertight "ghost face" sheet and ~tripled the triangle count on layered walls. With the interfaces left open, the 2D section's polygon builder is now bidirectional (each open band closes at the interface chord) and, for 3+ layer walls, stitches the disconnected end strips of an interior layer (which has no wall face) back into a closed fill at the interface chords — so every layer keeps its section fill.
