---
"@ifc-lite/cli": patch
---

`ifc-lite create storey` works instead of rejecting itself. `storey` was listed in `ELEMENT_TYPES` — so it passed the usage check and appeared in `--help` — but `addElement`'s switch had no case for it, so it fell through to `default` and fataled with `Unknown element type: storey`, printing the very list that had just offered it. `createCommand` already builds the project's storey before dispatching, so the type now returns that storey: a bare project/site/building/storey skeleton, with `--storey` and `--elevation` honoured and `--pset`/`--qset`/`--material` still attaching to something real.

The advertised count was wrong in four places at once (28 real, 29 in the error list, "30+" in the CLI help and package README, "29 element types" in the guide). It is 29 everywhere now, and a test drives every entry in `ELEMENT_TYPES` through `addElement` so a listed-but-unbuildable type cannot come back.
