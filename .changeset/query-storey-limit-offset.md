---
'@ifc-lite/cli': patch
---

Behavior fix: `ifc-lite query --storey <name>` now honours `--limit` and `--offset`.

The `--storey` filter takes its own branch, post-filtering the entity list by hand,
and handed that unsliced array straight to the printer. Both flags were parsed and
validated on this path and then had no effect at all, so `--storey X --limit 2`
printed every entity in the storey. The plain and `--where` paths already applied
the slice; the storey branch now applies the same one, including when `--storey`
is combined with `--where`. Scripts that passed `--limit`/`--offset` alongside
`--storey` and silently received the full listing will now receive the requested
window.
