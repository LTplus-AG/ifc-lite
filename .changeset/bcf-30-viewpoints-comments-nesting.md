---
"@ifc-lite/bcf": patch
---

Fix BCF 3.0 markup.bcf writing and reading the wrong `Comments`/`Viewpoints` structure.

buildingSMART's BCF 3.0 `markup.xsd` moves `Comments` and `Viewpoints` inside `<Topic>` (each wrapped in its own plural container, with per-entry `<ViewPoint Guid="...">` — capital P, distinct from the `<Viewpoint Guid="..."/>` a `<Comment>` uses to reference one), after `RelatedTopics`. BCF 2.1 instead keeps them as top-level `<Markup>` siblings after `</Topic>`, in schema order `Comment*` then `Viewpoints*`.

The writer previously emitted the 2.1-shaped flat siblings — `Viewpoints` before `Comment` — unconditionally for both versions, which is schema-invalid at 3.0 and out of order at 2.1. The reader's markup lookup only matched the 2.1 top-level `<Viewpoints Guid="...">` shape, so on a genuine 3.0 file the per-viewpoint snapshot filename was silently dropped and resolution fell back to guessing our own `Snapshot_<guid>` naming convention. Verified empirically against buildingSMART/BCF-XML's own release_3_0 conformance fixture (`Test Cases/v3.0/Visualization/Perspective camera`): before the reader fix, the snapshot referenced by that fixture's `markup.bcf` was not attached to the parsed viewpoint.
