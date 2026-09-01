---
'@ifc-lite/bcf': patch
---

Refuse to write a BCF 3.0 `PerspectiveCamera/FieldOfView` outside `visinfo.xsd`'s `(0, 180)` exclusive facet, instead of emitting a finite-but-invalid archive.

`FieldOfView` is `xs:double` with `minExclusive="0"` and `maxExclusive="180"` in BCF 3.0's `visinfo.xsd`. The writer's only guard on write-side numbers, `xsdDouble`, checks finiteness — it says nothing about a value that is out of range but perfectly finite, so `0`, a negative number, or `180` and above walked straight through it and were written as-is. Every existing test that touched this field validated the *schema's* rejection of a hand-mutated string, never the writer's own behavior on an out-of-range `fieldOfView` in the input `BCFProject`; `AspectRatio`, the sibling 3.0-only facet-bearing field, already had this guard and `FieldOfView` did not.

`writeBCF` now throws for a 3.0 camera whose `fieldOfView` is `<= 0` or `>= 180`, naming the viewpoint, the same policy `requireAspectRatioElement` and the `Topic/@TopicType`/`Topic/@TopicStatus` checks already apply: no safe value to invent, and no invalid archive handed back silently. BCF 2.1's own `FieldOfView` facet (`[45, 60]`) is deliberately left unenforced — its schema annotation says that limitation will be dropped and viewers should expect values outside it.
