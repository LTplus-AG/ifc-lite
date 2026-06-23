---
"@ifc-lite/drawing-2d": patch
---

Reconstruct per-layer section fills from open (cap-free) material-layer bands. The geometry slicer no longer caps the layer interface planes — capping doubled each shared interface into a coincident, non-watertight "ghost face" sheet and ~tripled the triangle count on layered walls. With the interfaces left open, the 2D section's polygon builder is now bidirectional (each open band closes at the interface chord) and, for 3+ layer walls, stitches the disconnected end strips of an interior layer (which has no wall face) back into a closed fill at the interface chords — so every layer keeps its section fill.

Harden that reconstruction on OPENING-cut walls so the 3D section cap covers every layer (no more wall-reads-hollow in section view). An opening splits each layer into disconnected solid chunks; the old greedy nearest-endpoint stitch hopped an interior layer's strip to the strip ACROSS the opening, emitting one self-overlapping polygon that bridged the void and failed to fill. Closure now runs along the interface lines (the principal/length axis of the band, so it is robust to rotated walls): endpoints are paired CONSECUTIVELY along each interface line, which closes each solid chunk and leaves the opening between chunks empty. Ambiguous layouts fall back to the previous stitch, so no case is made worse.
