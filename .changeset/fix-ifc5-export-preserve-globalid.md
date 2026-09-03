---
"@ifc-lite/wasm": patch
---

Fixed `ifc-lite export --format ifcx` (and any other caller of the Rust IFC5/IFCX exporter) minting a brand-new node path for every product instead of using its IFC `GlobalId`. An element converted from IFC to IFCX lost its original identity — a BCF topic, diff, or any other reference keyed on the source model's GlobalId could no longer find it in the converted file. The exporter now reuses the entity's own GlobalId as its IFCX path when it has one (mirroring the TS exporter, which already did this), falling back to the deterministic synthesized path only for entities with no GlobalId (e.g. the `IfcProject` root).
