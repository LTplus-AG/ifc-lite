---
"@ifc-lite/wasm": patch
---

Fix `EntityDecoder::length_unit_scale`/`plane_angle_to_radians` (`rust/core/src/decoder.rs`) and their `find_ifcproject_id_inner` fallback (`rust/processing/src/prepass.rs`) comparing the scanned `IFCPROJECT` keyword case-sensitively. A file whose keywords are lowercase or CamelCase (STEP keyword case is not significant) silently defaulted the length-unit scale to `1.0` instead of the declared value — a 1000x error on a millimetre model feeding curve tessellation, appearance/texture mapping, and unit conversion.

`georeferencing_candidate_type` (`rust/processing/src/georeferencing.rs`) had the same defect: it classified `IfcMapConversion`, `IfcProjectedCRS`, `IfcPropertySet` and `IfcSite` candidates with a case-sensitive `match`, so a lowercase- or CamelCase-keyword file reported no georeferencing at all despite carrying complete `IfcMapConversion` data. It is the gate for both the standalone extractor and the native geometry scan, so both paths were affected.

`find_ifcproject_id` also stopped on the first `#<id>=IFCPROJECT(` it could backtrack to, including one written inside a STEP string literal, and returned that id — which then fails the resolver's own `IFCPROJECT` type check and restores the same silent 1.0 default. It now requires the `#` to actually start a record (preceded, across trivia, by `;` or the start of input). Matching the keyword case-insensitively widened this pre-existing hazard from uppercase decoys to ordinary lowercase prose in a description or comment, so it is fixed here.

The same scan now prefilters on the keyword's `J` rather than its leading `I`: every IFC keyword starts with `I` and GUIDs are dense in `I`/`i`, so the lead-byte scan hit on nearly every record. On a 20 MB project-less file this measured 7.6-13.1 ms against 0.33-0.36 ms for the `J` prefilter (and 0.8-1.0 ms for the case-sensitive `memmem` it replaced).

This is one part of a broader case-sensitivity class tracked in issue #4497; the remaining sites are enumerated in the PR.
