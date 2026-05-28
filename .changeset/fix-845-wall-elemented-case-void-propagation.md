---
"@ifc-lite/wasm": patch
---

Propagate `IfcRelVoidsElement` cuts to aggregated parts so
`IfcWallElementedCase` walls (and any host whose body lives on its
aggregated children) actually show the authored openings (issue #845).

The reporter's fixture is the canonical IFC4
`ifcwallelementedcase` model: an `IfcWall` with no body
representation that aggregates a track frame plus drywall panels via
`IfcRelAggregates`. The openings are authored directly against the
wall, so the existing void path ran the cut against an empty host
mesh — the kernel logged "Rectangular cut SILENT NO-OP" and the
window/door cutouts never reached the panel geometry that actually
covers them.

Build a parent → children index from `IfcRelAggregates` during the
entity scan and, after the void index is collected, breadth-first
push every opening on a host down through the aggregation tree
(visited-set cycle guard, deduplicate against authored direct voids).
Each aggregated leaf now sees the openings and clips its mesh against
them.

Regression coverage:

- `rust/processing/src/processor.rs` — four `propagate_voids_to_aggregated_parts`
  unit tests cover the full sub-tree walk, dedup against authored
  voids, aggregate cycles, and no-op when the host has no parts.
- `rust/processing/tests/issue_845_wall_elemented_case.rs` — drives the
  reporter's fixture through `process_geometry` and asserts both
  drywall panel meshes (#145 Panel Forward, #146 Panel Reverse) end
  up with substantially more triangles than the pristine 12-tris
  slab — proof the openings now carve into them.

Fixture `tests/models/issues/845_wall_elemented_case.ifc` (25 KB)
added to the manifest.
