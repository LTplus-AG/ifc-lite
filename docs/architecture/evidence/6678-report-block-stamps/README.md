# Evidence: stamp rows of IDS and information-validation report blocks

Output of the PDF composer (`composeDocument`, A4 portrait, compact layout, benchmark ring on) for one
block with two evaluated models, once with `showStamp` absent and once with `showStamp: false`. The y
values are the composer's drawn text baselines in points, copied from the run; nothing here is a browser
screenshot or a downloaded PDF.

```
ids, showStamp absent
  y=  81.0  IDS report: Design IDS
  y=  98.0  Checked 10 · Passed 7 · Failed 3 · 70% passed
  y= 148.0  Validation run: 2026-01-15T10:00:00.000Z
  y= 161.0  Models: architecture.ifc, structure.ifc
  y= 176.0  Walls
  y= 176.0  7/10 · 70%
ids, showStamp false
  y=  81.0  IDS report: Design IDS
  y=  98.0  Checked 10 · Passed 7 · Failed 3 · 70% passed
  y= 148.0  Walls
  y= 148.0  7/10 · 70%
rules, showStamp absent
  y=  81.0  Information validation report: Quality rules
  y=  98.0  Checked 10 · Passed 7 · Failed 3 · 70% passed
  y= 148.0  Validation run: 2026-01-15T10:00:00.000Z
  y= 161.0  Models: architecture.ifc, structure.ifc
  y= 176.0  Walls
  y= 176.0  7/10 · 70%
rules, showStamp false
  y=  81.0  Information validation report: Quality rules
  y=  98.0  Checked 10 · Passed 7 · Failed 3 · 70% passed
  y= 148.0  Walls
  y= 148.0  7/10 · 70%
```

Hiding removes both stamp rows (28 pt: the 14 pt run row and the 14 pt models row) and the first check
moves up by exactly that. The preview is asserted against the same composed output in
`DocumentPanel.reportBenchmarks.test.tsx`, which mounts the real panel over the real validation engines.
