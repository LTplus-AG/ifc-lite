---
"@ifc-lite/wasm": patch
---

Floor slabs whose profile already contains its holes, and whose openings fill those holes exactly, no longer come out torn by the opening cut. Two things went wrong together. A corner that the file states twice, once for the hole and once for the opening, could reach the cut a hair apart (15 micrometres, one step of the internal grid), depending on the coordinate frame in use; such an opening corner is now treated as the slab corner it is. And an opening corner lying exactly on a hole wall could be nudged off it onto the wall of a neighbouring hole that was almost, but not quite, in line; it is now left where it is. On the reference model the affected slabs come out closed from the viewer as well as from the server and CLI pipeline. Unions and boolean-clipping results are unaffected.
