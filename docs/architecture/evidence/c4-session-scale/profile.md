# Session-scale diagnosis (#8452, part of #9296)

Recorded before implementation, 2026-11-08. Source b217ddd529fb (authoring
packages identical to the profiled 570668f1a6 build). PC/WSL, shared host:
these are diagnostic samples, not qualified timing benchmarks.

Command: `node --cpu-prof packages/cli/dist/index.js run
tests/modelling-parity/probes/sdk/lib/perf-scale.js blank.ifc`, with
`PARITY_SCALE_BUDGET_MS=5000`, through fleet local admission.
Original receipt: f61d8c00-5e79-4196-89ea-90fdbc50cf4b.
Profile: CPU.20261108.221113.43689.0.001.cpuprofile, 6.04 seconds,
under ~/modelling-parity/c4-profile/ (finite-retention diagnostic evidence).

Top three causes by sampled self time:

1. **Whole-overlay cloning (43.2%).** prepareAtomic makes four deep copies;
   SDK compound recording adds another. Nested builder transactions repeat it.
2. **Whole-overlay comparison (19.8%).** sameOverlayValue/matchesOverlayState
   compare every map, entity and historical mutation before publication, twice.
3. **Snapshot garbage (15.9%).** GC collects those repeated copies. Index
   rebuilding adds another 2.0%, rather than maintaining existing class buckets.

The five-second probe authored 162 columns: batches cost 11.32 ms at 4 session
products, 28.26 at 54, 46.20 at 104, and 59.25 at 154. No remesh is involved.
Prior windowed profiles in ~/modelling-parity/r2-design.md also identify schema
name signatures and per-source relationship rebuilding as copy costs. Those
must be addressed in shared helpers, in coordination with the copy lane.

Implementation approach: detached sparse drafts, per-entry read/write sets,
and append-aware history; publish and record inverses from changed entries.
Keep escaping prepareAtomic snapshots and their exact nested-edit validation.
