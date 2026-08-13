---
"@ifc-lite/clash": patch
"@ifc-lite/cli": patch
---

Report it when `groupClashes({ by: 'cluster' })` consolidates nothing, instead of silently returning one group per clash.

Measured on a real MEP model (self-clash among drainage `IfcFlowSegment`s, distribution-run contact points scattered several metres apart): cluster grouping at the default 1.5 m epsilon produced 15 groups from 18 clashes — barely different from no grouping at all. The default epsilon was investigated separately and deliberately kept: across 12 public models there is no defensible constant (raising it to 2.0 m collapses an unrelated structural model's 10 real clashes into one group), so this is not a tuning fix.

Adds `isClusterGroupingIneffective(clashes, groups)` to `@ifc-lite/clash`: a narrow, exact check — true only when every clash landed in its own singleton group (`groups.length === clashes.length`, with more than one clash) — deliberately not a fuzzy "mostly ineffective" threshold, which would repeat the epsilon problem with a different undefensible constant.

`ifc-lite clash --bcf ... --group cluster` now prints a stderr note when this fires, naming the other grouping modes (`rule`, `typePair`, `element`) rather than picking one — none of them is a reliable universal answer either: on the measured model, `--group element` produced *more* groups than clashes (33 from 18), since it files each clash under both participating elements rather than merging along the run.
