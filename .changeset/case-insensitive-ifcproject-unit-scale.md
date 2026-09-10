---
"@ifc-lite/wasm": patch
---

Fix `EntityDecoder::length_unit_scale`/`plane_angle_to_radians` (`rust/core/src/decoder.rs`) and their `find_ifcproject_id_inner` fallback (`rust/processing/src/prepass.rs`) comparing the scanned `IFCPROJECT` keyword case-sensitively. A file whose keywords are lowercase or CamelCase (STEP keyword case is not significant) silently defaulted the length-unit scale to `1.0` instead of the declared value — a 1000x error on a millimetre model feeding curve tessellation, appearance/texture mapping, and unit conversion. This is one instance of a broader case-sensitivity class tracked in issue #4497; the other three sites listed there are unchanged.
