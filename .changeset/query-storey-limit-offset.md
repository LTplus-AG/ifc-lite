---
'@ifc-lite/cli': minor
---

Behavior fix: `ifc-lite query --storey <name>` now honours `--limit` and `--offset`.

The `--storey` filter takes its own branch, post-filtering the entity list by hand,
and handed that unsliced array straight to the printer. Both flags were parsed on
this path and then had no effect at all, so `--storey X --limit 2` printed every
entity in the storey. The plain and `--where` paths already applied the slice; the
storey branch now applies the same one, including when `--storey` is combined with
`--where`. Scripts that passed `--limit`/`--offset` alongside `--storey` and
silently received the full listing will now receive the requested window.

`--offset` is also validated now, the way `--limit` already was. It never had been,
and applying it on two more paths would have spread three different wrong answers
instead of one: `slice(NaN)` is inert, `slice(-2)` returns the LAST two entries
rather than skipping two, and the plain path let `NaN` reach the backend's own
guard as an uncaught `TypeError` instead of a clean error. `ifc-lite query --offset
-2` and `--offset abc` now exit with `Invalid --offset` on every path, where
`--offset -2` previously returned the tail of the list and reported success.
