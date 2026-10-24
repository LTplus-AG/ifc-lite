---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`. An export plan's `WriteReport::removed` lists every record the plan dropped from the output, by express id, each with why it went (`RemovalReason`): the plan deletes it, an opening or projection lost its host relationship, it named a removed record through a single-valued attribute, a relationship's mandatory members were all removed, nothing referred to it any more, or a patch replaced it. A caller reconciling its own model can read the reason instead of predicting it. It is recorded where each removal already happens, with no extra pass.
