---
'@ifc-lite/clash': patch
---

Fix two clash-detection bugs.

`matchesSelector` mishandled a selector made of only negated alternatives
(e.g. `!IfcWall|!IfcSlab`): the top-level `!` handling stripped only the
first leading `!` and negated the recursive match on the remainder, so the
second exclusion's type still matched. `matchesSelector('IfcSlab',
'!IfcWall|!IfcSlab')` returned `true` instead of `false`. A pure negation
list is now treated as an implicit AND of exclusions -- "match everything
except A and except B" -- rather than the literal (and useless, tautological
for any single input) OR-of-negations reading. Mixed positive/negative
selectors (e.g. `IfcWall|!IfcSlab`) are unaffected.

`clusterSharedFaces`'s `classify` step relabeled a small-area coplanar
contact (area between `pointAreaM2` and `surfaceAreaM2`) as `kind: "line"`,
but such a cluster comes from `buildSurfaceCluster`, which always sets
`length_m: 0` -- contradicting the field's own documented invariant
("line only -- 0 otherwise") and the viewer's contact overlay, which renders
`"line"` clusters as a 2-point segment rather than the polygon boundary a
surface cluster actually has. This band is now classified `"surface"`.
