<!-- SPDX-License-Identifier: MPL-2.0 -->
# Complete constructor seams and demand-driven raw execution

This layer extends owned lower/evaluate seams to all nineteen registered leaf
families. The nine added families are advanced BRep, B-spline surface, face and
shell surface models, structural face and edge, sectioned solid, alignment and
linear extrusion surface. Production processor entry points use these same
builders. This completes constructor seams, not complete geometry-platform
migration: booleans/CSG are the other two registry families and their operation
coverage remains partial.

The opt-in raw operation evaluator schedules operands on demand. An empty first
operand of difference/intersection skips numerical evaluation of the second;
unused ownership is released iteratively without losing future shared roots.
Source admission remains eager. Empty-first union losses precede second-operand
execution. Shared diagnostic fan-out is bounded without deduplicating semantic
losses. Fresh instruction failures remain owned on execution errors, separately
from per-root repeated-edge diagnostics.

Face-refusal and curve-cap reports cross source disposal and thread transfer.
Scoped capture preserves the caller's pending thread-local reports. Decoder
refusal IDs are a cumulative snapshot, including earlier decoder reads, rather
than per-root attribution. Mixed surface models retain the original source and
numerical refusal ordering. Generic face references preserve historically
permissive positional admission through generated schema indices.

Independent invariants cover holed sectioned volume/winding, bounded alignment
ribbons, small survey-coordinate surface areas, rational surface sampling,
cylindrical radius, revolution angles, structural ribbon orientation, malformed
references and mixed-face diagnostics. Real-file raw replay covers advanced shells,
Revit linear surfaces and face collections in addition to prior polygonal,
faceted and ordered-boolean cases. The final raw replay run executes all seven tests without fixture skips. Native
workspace validation records 5,622 passed invocations and 47 ignored cases; fresh
WASM records 206 passed checks and seven missing-fixture skips. These totals do not
establish full corpus coverage.

`source-manifest.json` identifies the candidate. `validation.json` records actual
commands, verdicts and local raw-log hashes. `default-path-perf.json` records
interleaved base/candidate whole-worker-pool measurements and ordered geometry
fingerprints. All six measured fixtures retain matching mesh counts and ordered
geometry fingerprints across base/candidate runs. Those fingerprints exclude UV/texture/instance/text metadata and
are not complete-result byte identity. Shared-host timing is unqualified; no
latency, memory or retained-BRep speedup claim follows. Some branch timing samples
are slower; exclusive-runner repetition and profiling remain required.

Canonical product/mapping placement, RTC publication, appearance, host openings,
half-space/grouped-cut policies, cutter inner shells, contextual budgets and
conditional source recovery still need coherent plan integration. Retained
analytic BRep execution, package closure on every supported platform, complete
consumer/corpus qualification and process/payload memory limits remain open.
The exact kernel remains the production engine. No complete switch is activated
by these receipts. Prior receipt directories remain historical snapshots.
