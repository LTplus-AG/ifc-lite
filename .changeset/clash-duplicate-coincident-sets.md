---
"@ifc-lite/clash": minor
"@ifc-lite/viewer": patch
---

Report duplicates as coincident sets, not pairs. `findDuplicates` is pairwise, so N coincident copies of one object produce N(N−1)/2 rows and each copy is named in N−1 of them — three triplicated columns read as nine findings with every object mentioned twice. No row was ever literally repeated, but the list overstated the problem and the same object kept reappearing.

New `groupDuplicateSets(result)` partitions a duplicate result into the connected components of the pair graph: each reported clash is an edge between two model-qualified `(model, key)` elements, and each component becomes one `ClashGroup` titled e.g. "3 coincident IfcWall objects". Unlike `groupClashes({ by: 'cluster' })` it needs no epsilon and cannot fuse two unrelated duplicate sets that happen to stand within the 1.5 m cluster radius of each other. Sets that span models group correctly (the same object delivered in two files). A set's severity is its most severe member, so a set containing an exact-duplicate pair still surfaces as `major`.

Connected components treat coincidence as transitive, which under an IoU threshold it strictly is not: A≈B and B≈C puts A and C in one set even if A≉C. That is deliberate — a chain of near-coincident objects is a single coordination issue, and the strict alternative would put the same object back into several findings.

Detection and thresholds are unchanged; `ClashResult` still carries the same pairwise clashes, so the other grouping modes and BCF export are unaffected. In the viewer, a duplicate scan now RENDERS these sets: the clash panel shows one section per coincident set ("3 coincident IfcColumn objects") with the member pair rows inside it, instead of bucketing the pairwise rows under the generic severity/rule/type-pair headers; the scan's telemetry counts sets rather than pairwise rows for the same reason. The duplicate scan's position tolerance is also now a setting (Clash settings → "Duplicate tolerance", default 10 mm) — it previously always ran at the library default, with no viewer control.

The panel's "Group by" control is now disabled during a coincident-set view: it previously stayed clickable and its selection persisted, but the sections it draws are always the coincident sets during a duplicates-only run, so choosing "By severity" or "By type pair" changed nothing on screen.
