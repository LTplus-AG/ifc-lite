---
"@ifc-lite/cli": minor
"@ifc-lite/geometry": minor
---

`diagnose-geometry` gains `--product <expressId|GlobalId>` and `--type <IfcType>` flags to narrow the worst-failing-hosts detail list to a single product or IFC type. Worst-failing hosts now also report a world-space bounding box and final triangle count when a void cut captured them, surfaced in both `--json` and the human-readable report.

Fixed `--quiet`/`--verbose` on `diagnose-geometry`: its status line ("Wrote diagnostics to...") now routes through the leveled logger like every other command, so `--quiet` actually silences it instead of always printing to stdout via a raw `console.log`. The JSON/report payload itself is unaffected by verbosity, same as every other command.
