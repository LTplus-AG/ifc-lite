---
"@ifc-lite/geometry": patch
"@ifc-lite/viewer": patch
---

Add a `?geomWorkers=N` override for the geometry worker pool, and document the
per-tier worker caps as a memory-bandwidth ceiling.

The parallel geometry pool picks a worker count from a cores/memory heuristic.
A `?geomWorkers=N` A/B sweep on a large (722 MB) georef model showed that, with
the pure-Rust exact CSG kernel, geometry wall-time is bound by **memory
bandwidth**, not CPU cores: 3→4→5 workers gave no geometry speedup (flat
wall-time, higher peak memory) and progressively starved the co-running parser.
So the existing caps are correct for this class of file and are left unchanged —
only their rationale is updated in comments.

The override (`?geomWorkers=N`, persisted to localStorage so it survives the
reload a re-measure needs; `?geomWorkers=0`/`auto` clears it) lets a user measure
their own host's optimum, since the bandwidth ceiling is hardware-specific. It is
threaded to `computeWorkerCount`, which honours it but still clamps to the memory
budget, so the knob can never OOM the tab. Geometry output is byte-identical
across worker counts (verified in the wild: identical mesh count at 3 and 4
workers) — the count only repartitions which worker meshes which disjoint,
deterministic element slice.
