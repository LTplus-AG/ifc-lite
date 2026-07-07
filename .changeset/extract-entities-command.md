---
"@ifc-lite/cli": minor
---

Add `ifc-lite extract-entities` — isolate a handful of entities from a large IFC into a small, valid, viewable standalone model, the "reproduce a suspect element" step of a geometry-triage loop.

Selectors (unioned): `--product <GUID|expressId>` (repeatable / comma-list), `--type <IfcType>`, `--storey <GUID|name|expressId>` (every product placed under a storey via its placement chain), and `--detect [--top N]` (the meshes a geometry-triage pass ranks most unusual). The output carries each selected product's full forward reference closure plus the shared context roots (IfcProject, unit assignment, geometric contexts, and the site/building/storey spatial skeleton) and every spatial-containment relation whose members are all kept — so the result parses and renders on its own with zero dangling references. Add `--view` to open it in the viewer.

Crucially, a selected element also carries its openings and their fillers: every `IfcRelVoidsElement` whose host is kept (plus the `IfcOpeningElement` cutter) and every `IfcRelFillsElement` whose opening is kept (plus the window/door). These relations point *backward* to the host, so forward closure alone never reaches them — without this an isolated wall extracts as an uncut box, hiding the very void-cut geometry a triage loop needs to reproduce.

`extract-entities <file> --detect --report [--json]` prints a triage report without extracting, separating HARD defects (non-finite or `|coord|>1e4` vertices after the per-element local-frame/RTC recentre — genuine corruption) from REVIEW heuristics (oversized AABB) that are frequently legitimate for thin or large elements and must be eyeballed, not trusted.
