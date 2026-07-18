---
"@ifc-lite/wasm": patch
---

perf(geometry): 2D opening-subtraction fast path for extruded hosts

Wire IfcOpenShell's `boolean-attempt-2d` technique into the void-cutting pipeline. For an extruded host whose openings penetrate straight through the extrusion depth (parallel to the host axis), the exact 3D mesh-boolean is replaced by a cheap 2D polygon difference on the host profile plus a re-extrude of the holed profile. Per-opening hybrid: eligible through-openings take the 2D path, ineligible ones (perpendicular sleeves, partial-depth recesses) fall to the exact kernel on the re-extruded host, so one ineligible opening no longer forfeits a host's cheap ones. Every host reconciles by bounds + volume against the real mesh and self-checks watertight before it is emitted; any doubt defers to the exact kernel with the full opening set, so geometry output is equivalent (validated against the IfcOpenShell correctness harness — no per-element verdict regression). Gate `IFC_LITE_VOID_2D=0` to force the exact kernel. Default ON on native and wasm.
