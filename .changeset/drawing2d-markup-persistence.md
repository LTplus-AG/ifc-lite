---
"@ifc-lite/viewer": minor
---

2D drawing markup (measurements, polygon areas, text notes, revision clouds and display options) now survives a reload, matching the 3D pin notes it sat next to. Markup is saved to `localStorage` keyed by the loaded file's full-content SHA-256 hash, so it round-trips for the same file and never leaks onto a different one — the geometry cache's spread-sampled fingerprint is deliberately NOT reused here, since it can collide on two distinct files that differ only between its sample windows. The `SectionConfig` that produced the current view is saved alongside it. The generated `Drawing2D` itself, and imported DXF reference underlays, are not persisted yet: the drawing is cheap to regenerate from the section config, and a DXF underlay can carry arbitrary point counts that may exceed `localStorage`'s synchronous budget (tracked separately for an IndexedDB home).
