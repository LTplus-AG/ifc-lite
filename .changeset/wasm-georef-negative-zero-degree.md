---
'@ifc-lite/wasm': patch
---

Close the Rust residual left by the `@ifc-lite/parser` fix for `IfcSite.RefLatitude`/`RefLongitude` silently flipping a southern/western legacy-site georeference to northern/eastern when a writer signs a zero-magnitude compound-plane-angle degree token, e.g. `(-0, 30, 0)` for 0°30'S. The TS fix matched IEEE-754 negative zero directly (`parseFloat('-0') === -0`); the bundled Rust STEP tokenizer parses `IfcCompoundPlaneAngleMeasure` components through `i64`, which has no negative-zero representation, so the sign is lost before it ever reaches `compound_plane_angle_to_degrees`. `extract_from_site` now recovers it by re-scanning the entity's raw record bytes for the literal `-0` token on the `RefLatitude`/`RefLongitude` attribute pair only, instead of reworking the shared integer tokenizer that every other STEP integer attribute goes through.
