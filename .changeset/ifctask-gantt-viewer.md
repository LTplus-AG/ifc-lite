---
"@ifc-lite/viewer": minor
---

Add the full IfcTask / 4D construction-schedule experience to the viewer.

**Gantt panel** — a lower-panel workspace combining a task tree, a zoomable
SVG timeline with task bars / milestones / dependency arrows / playback
cursor, a toolbar (work-schedule filter, play / pause / loop / speed, time
scale), and an empty state. Live Gantt ↔ 3D selection highlight (one-way,
no isolation) and playback-driven visibility through the rendererʼs
hidden-entity channel.

**Schedule editing** — Inspector Task card (name, identification,
predefined type, milestone, start / finish / duration with any-two-of-three
reconciliation, assigned products, delete with cascade). Undo / redo
(descriptor-based lightweight snapshots for field edits; full snapshot for
structural edits), store-scoped transactions (drag-coalesced), add / delete /
reorder tasks. IFC STEP export routes through a centralised schedule splice
helper so generated / edited schedules round-trip cleanly on every export
surface.

**Generate from hierarchy** — a Generate Schedule dialog produces a work
schedule + tasks from the modelʼs spatial hierarchy (Storey / Building) or
geometry (Height-slice, with optional Class / Type / Name subgroup). Linked
FS dependencies and ghost-preparation look-ahead are opt-in.

**4D animation** — Synchro-style phased lifecycle (preparation ghost →
ramp-in → active task-type colour → settling fade → complete), demolition
inversion, customizable palette, and configurable palette intensity /
look-ahead / hide-untasked products. Animation layers live in a priority-
composited overlay registry (`registerOverlayLayer`), with a single
compositor hook owning the write to the rendererʼs hidden-entity + colour-
override channels.

**LLM integration** — built-in "Construction schedule (4D)" script template,
PDF / spreadsheet chat attachments, and `bim.schedule.*` read APIs reachable
from the sandbox.
