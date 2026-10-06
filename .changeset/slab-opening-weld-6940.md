---
"@ifc-lite/wasm": patch
---

Floor slabs whose profile already contains its holes, and whose openings fill those holes exactly, are torn less by the opening cut. The opening cutter was being nudged by a few micrometres off the hole wall it lay on and onto the wall of a neighbouring hole that was almost, but not quite, in line with it. An opening cutter's corner that lies exactly on a host face is now left there when the only other candidate is a separate face lying within the same tolerance. On the reference model the affected slabs come out closed from the server and CLI pipeline. In the viewer, which cuts each element in its own local frame, the same slabs lose more than half of their open edges but are not yet closed. Unions and boolean-clipping results are unaffected, and faces that the coordinate snap creased into several facets behave as before.
