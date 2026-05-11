---
"@ifc-lite/geometry": patch
---

Render `IfcExtrudedAreaSolidTapered` (issue #628).

Tapered extrusions (e.g. beams or columns whose cross-section transitions
between a `SweptArea` profile at the base and an `EndSweptArea` profile at
`Depth`) were recognised by the parser but silently skipped by the geometry
engine, so the elements never appeared in the viewer.

The Rust geometry crate now ships:

- `extrude_profile_lofted` in `extrusion.rs` — generates caps from each
  profile's own triangulation and stitches the side walls 1:1, resampling
  the shorter outer loop by arc length when authoring tools emit profiles
  with mismatched vertex counts. Side normals are computed from the actual
  3D quad so sloped faces shade correctly.
- `ExtrudedAreaSolidTaperedProcessor` registered alongside the existing
  `ExtrudedAreaSolidProcessor`. Falls back to a uniform extrusion if
  `EndSweptArea` is missing so malformed files still render.
- `IfcExtrudedAreaSolidTapered` is now accepted by `profile_extractor`
  (used by 2D drawing projection) and the `IfcMappedItem` dispatcher.

Out of scope for this patch and called out for follow-up:
`IfcRevolvedAreaSolidTapered`, plus tapered solids participating in
`IfcBooleanClippingResult` / openings / material-layer slicing.
