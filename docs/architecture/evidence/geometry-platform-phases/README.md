<!-- SPDX-License-Identifier: MPL-2.0 -->
# Canonical production-stage migration evidence

This candidate separates synchronous element strategy planning, geometry execution
and presentation assembly while retaining `produce_element_meshes` as the only
native/browser entry point. It also extracts an owned production extrusion
construction that replays without an IFC decoder. These are steps toward complete
plan/execute/assemble coverage; most family lowering and the operation graph remain
unfinished. Exact arithmetic remains the production mathematical engine.

Four new element tests use real IFC geometry to prove the alignment retry path,
type-map placement/class/metadata contracts, an opening consuming its host versus
a normal net-volume control, and occurrence-only success without duplicate flat
geometry. Six new extrusion invariants prove replay after source disposal,
oblique holed and disjoint-composite volumes/bounds, empty-profile admission order,
malformed-input refusal order and historical direction defaults.

`source-manifest.json` identifies the actual candidate sources and built boundary
artifacts. `validation.json` records commands, outcomes and raw-log digests. Full
raw workspace output is retained locally rather than transcribed or edited into
new evidence. Historical source fingerprints in earlier evidence directories
remain historical; they do not qualify the current candidate.

`browser.json` is actual two-Worker Chromium execution of the rebuilt independent
boundary, including real deadline/initialization failures and kernel recovery. It
does not establish integration of a retained BRep backend into the application.

`default-path-perf.json` compares separately built base/candidate whole-worker-pool
probes on the two recorded authoring models, with five iterations per invocation
in ABBA order and ordered output fingerprints. Shared-host timing is diagnostic,
not a qualified latency or memory improvement. No production engine selection,
existing geometry reference, deterministic hash pin or performance baseline moves.

Parallel fault testing exposed an executable-publication race in the test harness:
a dynamically written executable could return `ETXTBSY`, hidden by a transient PID
poll. Tests now execute an immutable fixture through per-test symlinks and inspect
completed startup results and durable peer receipts. The same parallel stress
completed eighty suite runs (640 test invocations) without failure. Production
supervision code was unchanged; deadlines were not increased and no retry hides
startup errors.
