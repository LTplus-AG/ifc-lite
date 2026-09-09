---
'@ifc-lite/export': patch
---

`splitTopLevelStepArguments` — the validating splitter `replaceStepArgument`
uses to write a STEP attribute by index — now rejects an argument list whose
parts do not each parse back as one well-formed STEP value (a string, `$`,
`*`, a bare keyword/number/`#`-reference token, or a typed value/list).

The three checks it already had (quote parity, paren depth, final depth)
track scan state, not slot content, and can all pass on a slot list that is
not the record's actual arguments: an undoubled `'` inside one string-typed
argument can read as a string spanning into the next one, swallowing a real
`),NAME(` boundary, and a comment sitting alone between two commas becomes a
phantom slot that shifts every index after it. Either way,
`replaceStepArgument` would write a value into the wrong slot and report
success on a record it had actually corrupted.

`replaceStepArgument`'s one caller (`rewriteTypeOwnedPsetLine`) already
treats a `null` result as "could not repoint" — it keeps the line unrewritten
for that slot and surfaces a warning rather than dropping the record, so this
newly-reachable rejection degrades the same way an unparseable record already
did.

Two follow-ups, since `splitTopLevelStepArguments` has five call sites total
and the per-part check reaches every one of them, not only
`replaceStepArgument`:

- The per-part check did not recognize the ISO 10303-21 binary literal
  (`"..."`, e.g. `"0123ABC"`) as a value, so a perfectly legal line
  containing one was rejected outright. `isWellFormedStepSlot`/`parseValue`
  now accept it.
- `unit-normalize.ts`'s `rescaleEntityLengths` — reached through
  `MergedExporter`'s cross-unit merge path — treated that `null` as "nothing
  to do" and returned the line's length/area/volume data UNSCALED, silently:
  the one call site among the five where "unknown, don't act" is not a safe
  fallback. It now throws instead. The other three call sites
  (`merged-context.ts`, `merged-subcontext.ts`) already read `null`
  permissively as "unresolvable, don't unify" — audited and left as-is, since
  falling back to not merging is the safe direction for a WCS/kind
  comparison.
