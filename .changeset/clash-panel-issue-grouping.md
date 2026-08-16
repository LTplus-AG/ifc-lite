---
"@ifc-lite/viewer": minor
---

Surface the existing spatial clash grouping (`groupClashes({ by: 'cluster' })`, already used for BCF export) in the Clash panel's results list itself. Previously the panel only ever listed raw element pairs, so a model where several nearby pairs are really one coordination problem (e.g. a cluster of beam clashes at a single connection) read as many rows instead of one issue.

The panel now shows a "Pairs" / "Issues" toggle plus an issue count next to the pair total. In the Issues view, results are grouped by spatial proximity (default cluster radius 1.5 m, adjustable in Clash settings' existing "Cluster radius" field); each group is expandable to the individual pairs it contains — nothing is hidden, only re-organized.
