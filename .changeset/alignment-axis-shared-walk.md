---
"@ifc-lite/wasm": patch
---

An IFC4X3 alignment's `Axis` / `FootPrint` curve is now read through the same representation walk as element geometry. `Axis` still wins over `FootPrint` in either list order, the `FootPrint` still stands in when there is no `Axis`, and a segmented reference curve still contributes its gradient base curve. A malformed shape is no longer half-read; the alignment gets no directrix instead (Class X, malformed STEP only): when one of its representations does not resolve, when `Representations` is a bare reference instead of a list, or when an `Axis` or `FootPrint` representation lists an item that does not resolve or writes `Items` as a bare reference or `$`. A broken `Axis` no longer falls back to the plan-only `FootPrint`. The centerline overlay skips such an alignment, and alignment sampling reports it as having no supported directrix.
