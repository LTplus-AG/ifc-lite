# Hierarchy expansion timing (#5886)

Base `236b076ca`, branch `4f735f149` (the later test-only commit does not change
the measured viewer code). Both used root Turbo production viewer builds, the
same wasm runtime, isolated Vite previews, and fresh headless Chrome processes
with SwiftShader. `tests/e2e/hierarchy-expansion-perf.manual.mjs` loads the
authored IFC fixture(s), selects Class mode, toggles the first expandable class
22 times, discards two warm-up toggles, and measures click-to-rendered
`aria-expanded` for the remaining 20. Runs alternated base and branch on the
same host; no local build or test ran during the timings. Values below are
median milliseconds within each run.

| Fixture | Base, four runs (ms) | Branch, four runs (ms) | Median of run medians |
| --- | --- | --- | --- |
| `AC20-FZK-Haus.ifc` | 6.89, 5.77, 7.99, 9.46 | 6.34, 6.77, 10.65, 9.34 | 7.44 → 8.05 ms |
| AC20 + `Building-Architecture.ifc` | 11.73, 9.15, 9.02, 8.00 | 14.65, 11.52, 7.09, 8.12 | 9.09 → 9.82 ms |
| AC20 + `01_Snowdon_Towers_Sample_Structural(1).ifc` | 22.18, 14.91, 15.27, 15.75 | 13.86, 11.48, 13.42, 15.42 | 15.51 → 13.64 ms |

The small-model differences are below the run-to-run variation and are not a
credible speedup or regression claim. All four larger federation pairs improved; the median
of run medians fell about 12%. The two-model fixture combines 2.5 MB and
8.4 MB authored IFC files. The mounted test separately verifies that eight
toggles, search and external reveal cause no additional structural entity
scans. The 1/N parity suite compares every projected row field with the
previous builder for all five grouping modes and four expansion stages.

These timings measure a class toggle after loading, not model-load or
grouping-mode-switch latency. The browser includes React and DOM work, so
small-model results have high relative noise. The script and fixture paths
make the comparison repeatable.
