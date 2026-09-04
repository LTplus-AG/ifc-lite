---
"ifc-lite": patch
---

fix(viewer): assembly parts streaming in after hide/isolate/colour actions now respect those actions (#3865)

Presentation channels (hide, isolate, colour) now persist the complete set of aggregated descendants for an assembly, not just the parts that currently have geometry. This ensures that when a part streams in during loading, it's already included in the persisted action and will be hidden, isolated, or colored accordingly. Previously, parts that arrived after the action was applied would escape the presentation effect.
