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
