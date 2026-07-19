---
"@ifc-lite/wasm": patch
---

fix(geometry): void fast-path no longer drops a host's local-frame origin (misplaced walls)

The analytic prism / coaxial-union void fast paths (#1806/#1815) run `consolidate_coplanar` on their re-triangulated cut host. That helper rebuilt the mesh into a bare buffer whose `origin`, `rtc_applied`, and #1474 world-capture defaulted to zero, silently discarding the host's per-element local-frame `origin`. For a local-frame host (the wasm default, `origin != 0`) the whole voided element was then placed at the world origin — e.g. AC20-FZK-Haus's opening-bearing ground-floor walls floated ~6 m off the building. `consolidate_coplanar` only re-triangulates coplanar faces in place, so it now carries the input mesh's frame metadata onto the output (mirroring `refine_high_aspect_slivers`'s `rebuilt_like`); world-frame callers (`origin == 0`, the exact kernel) are unaffected. The fast paths' perf and triangle output are unchanged.
