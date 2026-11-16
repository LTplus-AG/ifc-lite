---
"@ifc-lite/create": patch
---

Structural derivation no longer guesses a support at every node of a flat member at the lowest level. A run of flat members at that level bears only at the nodes where members drawn down to it rise or where a column derived before, a wall, a slab or a footing under it holds it, when two or more of them hold it (not all on one line unless the run is), so a truss tie rests on its heels, not under the king post standing on it, and its overhangs stay cantilevers. A column drawn from a ground beam's top face counts as resting on it, like the post.
