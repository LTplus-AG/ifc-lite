---
"@ifc-lite/wasm": patch
---

An IFC4X3 alignment's `Axis` / `FootPrint` curve is now read through the same representation walk as element geometry. `Axis` still wins over `FootPrint`, and a segmented reference curve still contributes its gradient base curve. A malformed shape is no longer half-read: when one of the alignment's representations does not resolve, or `Representations` is a bare reference instead of a list, the alignment has no directrix; when an `Axis` representation lists an item that does not resolve, that representation is dropped and the `FootPrint` stands in.
