---
"@ifc-lite/query": minor
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

Added `matches` (regex) to the shared property/quantity comparison operator (#4094, follow-up to #4091). This is one of the three prerequisites #4094 names for honouring `/regex/` selector text end to end (GlobalId and `+` group support remain open); it now works everywhere `compareFilterValue` already backs `bim.query().where(...)` -- the CLI `HeadlessBackend`, the MCP backend, and the viewer's SDK adapter -- with no further plumbing, since all three already delegated to it.

`expected` is a bare regex source with no `/.../ ` delimiters (the same shape `parseSelector`'s regex literal already carries), tested against `String(actual)`. It is case-sensitive and does not boolean-normalize its operands (unlike every other operator here).

`expected` is caller-supplied and, via the MCP `query_entities` tool, can be agent/LLM-influenced -- `new RegExp(source).test(actual)` is not safe to run on untrusted input: a pattern like `^(a+)+$` is exponential in subject length in V8's backtracking engine (measured: a 35-character non-matching subject already exceeded 30s on a single synchronous call, which on the MCP server blocks every connected client, not just the offending query). Before compiling, a pattern is now rejected -- loudly, by throwing, not by silently returning `false` -- if it is over 200 characters, or if it contains a quantified group with another quantifier inside it (e.g. `(a+)+`), the shape this was measured against. This is a heuristic input constraint, not a proof of linear-time execution: it will reject some patterns that would in fact run fine, and it will not catch every ReDoS-capable shape (e.g. overlapping alternation like `(a|a)*`). A linear-time engine (e.g. RE2) was ruled out -- this environment cannot add a new dependency; a true wall-clock timeout was ruled out too -- `.test()` cannot be interrupted synchronously, and moving the match off the main thread is a much larger, separate change. Residual ReDoS risk from a pattern shape the heuristic does not recognise remains.

A rejected or syntactically-invalid pattern now throws rather than returning `false` -- fixing an inconsistency with this repo's existing fail-loud precedent for caller-supplied input (`--limit`/`--offset` validate up front with `fatal()`). A pattern is also now compiled once and cached by its source string, rather than recompiled for every candidate entity a `where`/`--where` query evaluates.

Reachable from:
- `bim.query().where(pset, prop, 'matches', pattern)` (SDK, and every backend built on it).
- The MCP `query_entities` tool's `property.op`.
- `ifc-lite query --where "Pset.Prop~=pattern"` and `ifc-lite export --where "Pset.Prop~=pattern"` (new `~=` token; plain `~` still means `contains`).

Not included here: `ifc-lite mutate --where` has its own separate, non-delegating comparator (`matchesFilter` in `mutate.ts`) and was left untouched; the CLI `--select`/selector flag, the MCP `selector` parameter, `bim.query().select()`, and the viewer's remaining unsupported selector constructs (`parent=`, `query:`, `+` group unions, material `Category`, GlobalId as a comparison, quantity rows through a property term) are all still open, tracked on #4094.
