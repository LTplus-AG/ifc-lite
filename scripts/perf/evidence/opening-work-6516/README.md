<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Opening work investigation (#6516)

The private model reported in #6516 is unavailable. The public witnesses below
reproduce related release-boundary work increases; they do not establish the
private model's complete cause or its reported slowdown factor.

## Public witnesses and release comparison

The source is [IfcOpenShell/files at 9fc2267d7f1ff35284c5b0fc28cc97bff7ace8e7](https://github.com/IfcOpenShell/files/tree/9fc2267d7f1ff35284c5b0fc28cc97bff7ace8e7).
The primary witness is `455--wall--infiniteLoop--augmented.ifc`, SHA-256
`684309f75c09c100b357f8a4d1ddf33c47d8b770b8c2187a77e68813297d6053`.
It is an IFC2X3 model with one wall and two opening elements. Its two cutters
miss the wall's existing solid despite overlapping its bounds.

`release-five-pairs.json` retains every sample, balanced run order, runtime
identity, output fingerprint and host-load snapshot from five fresh-process
pairs using the published geometry 6.0.0 / WASM 8.0.1 and geometry 7.0.0 /
WASM 9.0.0 packages. The ordinary `stream-diagnostic.mjs` measures the normal
Node streaming call and fingerprints output in a separate untimed pass.
The shared machine was active: these are diagnostic release comparisons, not
qualified browser worker-pool performance results.

The 455 witness consistently slowed across these samples, with unchanged
mesh and triangle counts but changed mesh bytes. The 994 witness also slowed,
but produced more host triangles; the 701 model has the same output fingerprint
and is not an independent geometry witness. The small initial 614 signal did
not survive repetition clearly enough to establish a regression.

## Causal route and rejected shortcut

Source-matched counters distinguish a strictly conforming unchanged batch from
a nonconforming batch whose volume oracle accepted an uncertain miss. On 455,
the release-6 route performs one group subtraction and no single subtractions.
Release 7 discards the unchanged group outcome and repeats both single cuts.
The current source repeats this work in two frame attempts: two group
subtractions followed by four single subtractions.

Those four single results are accepted `Retessellated` meshes. They are not
failed cuts and do not invoke the AABB fallback. In this path, `KernelError`
is telemetry for accepted output with open topology, not a rejection outcome.
Confusing that diagnostic with rejection would identify the wrong cause.

The first candidate consumed an unchanged batch only when its arrangement conformed
and every welded cutter has exactly the same ordered canonical kernel triangles
as the cutter used by the sequential route. A weld that crosses a kernel snap
boundary retains fallback. A lenient unchanged classification and an exhausted
element budget also retain fallback. Actual group cuts keep their existing
validation and acceptance path.

This avoided retessellation as well as work. It was not a byte-neutral change:
455 retains a denser original host with fewer unmatched edges. Later cutters
also retain more of their element budget. Tests therefore cover a miss that
would alter topology followed by a genuine cut, including analytical volume,
removed and retained spatial probes, and the existing emission closure audit.
Full-model topology validation rejected this candidate. All 178 available
catalogued files matched their manifest SHA-256 values. The exact source base
passed the complete differential census over 116 models and 1,170 void hosts;
the candidate introduced seven regressed rows. Independently, normal WASM
streaming reopened previously closed parts of `rvt01` hosts 6810 and 38800.
No golden was changed to accept those regressions. Close sampled surfaces and
nearly unchanged volume did not establish preservation of mesh topology.

The replacement retains the completed conforming group
mesh through the existing consolidation and validation gates. This is private
to the void-group caller; the public batch API retains its existing outcome
contract, uncertain misses still fall back, and multi-chunk misses do not use
the optimization. Same-count misses retain the existing single-cutter path;
the router's existing triangle-retention floor also remains in force.
The correctness checks pass; the performance verdict below remains limited by browser noise.

PR review found two defects in the independent distance reproducer: cancellation
in its Gram determinant discarded valid thin-triangle interior projections, and
unused buffer vertices were sampled as surface geometry. Both failed known-answer
checks before correction. The current cross-product calculation and referenced-only
samples were rerun against the same nine archived oracle cases and all 14 changed
native Revit parts. [Corrected outputs and provenance](surface-review-correction/README.md)
supersede the earlier derived distance figures, which remain archived. No geometry
production code, timed WASM artifact, topology threshold or benchmark changed.

The other public lead, 994, has identical opening meshes and the same operation
counts across releases, but its host gains triangles. Source-matched ordered
traces now locate the first changed intermediate: two identical raw hole rings
are dropped by release 6 and retained by release 7. The preceding host, cutter,
raw kernel and overlay fingerprints match. This identifies the ring-preservation
policy introduced by #4744, rather than the overlay dependency update, as the
first output divergence for that call. See [the trace record](release-994-first-divergence.md).
The traces do not establish whether those specific rings are correct against an
independent solid oracle, and carry no timing verdict. This candidate preserves
the ring policy; it does not recover performance by deleting small openings.

## Independent qualification of the retained group mesh

The [qualification record](current-v3-independent-qualification.json) retains
input and artifact hashes, closed-edge checks, centered-volume diagnostics,
coordinate provenance and symmetric sampled surface distances for the candidate.
The [portable method](portable-surface-method.md) and
[reproducer](compare-surfaces-6516.py) describe the pinned reference engine and
frame adapters. These finite samples do not prove continuous surface bounds or
exclude self-intersections. Public455 has an existing approximately 1.25 mm
worst reverse discrepancy against the reference on both sources; ISSUE_068's
candidate has a slightly larger worst forward discrepancy. Those limitations
remain explicit in the evidence.

Normal browser output captures include flat mesh fields, per-instance transforms
and template geometry, and coordinate metadata. AC20, ISSUE_129 and Holter are
byte-identical across the candidate and its source base. Changed Revit material
parts remain closed, including the parts that rejected original-host retention.
The public455 feature build reproduces default output exactly while its route
counters fall from six to two CSG invocations: both completed group misses are
retained and the four repeated single subtractions disappear. This establishes
removed work, not an end-to-end performance gain.

Official census regeneration changes only four reviewed volume-fingerprint cells:
Revit hosts 7075, 7834 and 33639, plus ISSUE_068 host 892212. Every topology and
triangle-count cell remains unchanged, including the heavy Holter fixture.
These integer census fingerprints are not a physical-volume oracle. Several
Revit native surfaces already have nonmanifold edge multiplicity, despite zero
unmatched directed edges; small centered-volume differences therefore remain
diagnostic. The candidate's reference-distance and volume drift can be slightly
worse, as recorded for 33639 and 892212. No tolerance or topology expectation is
relaxed to accept these results.

See [the diagnostic runner](../../opening-work-diagnostic.md) for source-matched
counter collection, original-batch identity checks and private-model reporting
limits. The counters and extra WASM getter are absent from default builds.

## Performance verdict and reproduction

The primary cold-browser run completed every load successfully, using five
adjacent base/candidate pairs per model and reversing order on alternate rounds.
Public455's worker-stream and first-visible medians moved beyond that fixture's
observed spread. Its full metadata-plus-render improvement remained within
spread. The overall reporter rejects the run as too noisy to qualify the full
cold-load/control result. This evidence therefore supports a fixture-specific
worker-stream signal and proven removed kernel work, **not an overall browser
speedup or neutral performance across all controls**.

The initial identical-build A/A also produced a false positive on AC20. A bounded
held-write A/A repeat removed the median skew; the subsequent candidate repeat
was again too noisy. Both attempts remain separate below. No samples were
excluded, combined to hide that result, or replaced by a native benchmark.
The shared machine's background application spawned some `git` processes even
while the participating agents held builds and writes. Per-process CPU samples
use executable names only. Browser rendering used software Vulkan/WebGPU; these
are actual worker-pool loads, without a hardware-GPU claim.

The five fresh native pairs attribute parse, geometry, pipeline-total and full
load phases. They agree with less geometry work on the target, but remain
companion diagnostics. AC20, ISSUE_129 and Holter have stable byte-identical
native fingerprints across sources; public455 and Revit deliberately differ.
The independent browser fingerprint pass additionally covers instance templates,
per-occurrence transforms, colors and coordinate metadata.

- [Primary browser samples](browser-ab-v3-runs.jsonl), [report](browser-ab-v3-report.json), [host load](browser-ab-v3-host-load.jsonl).
- [Initial A/A samples](browser-aa-v3-runs.jsonl), [report](browser-aa-v3-report.json), [host load](browser-aa-v3-host-load.jsonl).
- [Held AC20 A/A](browser-ac20-aa-held-runs.jsonl), [report](browser-ac20-aa-held-report.json), [host load](browser-ac20-aa-held-host-load.jsonl).
- [Held AC20 candidate pairs](browser-ac20-ab-held-runs.jsonl), [report](browser-ac20-ab-held-report.json), [host load](browser-ac20-ab-held-host-load.jsonl).
- [Native samples](native-five-pairs-runs.jsonl), [phase summary](native-five-pairs-summary.json), [host load](native-five-pairs-host-load.jsonl).
- [Browser output identities](browser-output-identities.json), [source/runtime provenance](measurement-provenance.json), [census verdict](census-verdict.json).

Recompute the unchanged reporter's primary verdict:

```sh
node scripts/perf/browser-ab-report.mjs \
  scripts/perf/evidence/opening-work-6516/browser-ab-v3-runs.jsonl \
  --base base --branch branch
```

For a fresh run, build both source revisions through the root Turbo dependency
graph with `--force`, retain their dist directories, and verify served WASM
identity and freshness. The [scratch harness patch](software-browser-harness.patch)
changes only launch flags and adjacent alternating pair order. Keep the canonical
harness unchanged:

```sh
cp scripts/perf/browser-cold-ab.mts scripts/perf/opening-timing-scratch-6516.mts
patch scripts/perf/opening-timing-scratch-6516.mts \
  < scripts/perf/evidence/opening-work-6516/software-browser-harness.patch
pnpm exec tsx scripts/perf/opening-timing-scratch-6516.mts \
  --corpus /path/to/corpus.json --dist-base /path/to/base/dist \
  --dist-branch /path/to/candidate/dist --iters 5 \
  --browser-executable /path/to/chrome --results-dir /path/to/new-results
```

The corpus JSON is an array of `{ "name": "public455", "path": "...ifc" }`
entries; immutable hashes for every measured input are in the provenance record.
Native binaries use the same profiling build as `scripts/perf/probe.sh` and are
frozen separately before measurement. Each recorded native command launches
`perf_probe <fixture> --cold --iters 1 --census --fingerprint --json`; five fresh
pairs give phase attribution without reusing a warmed process. No committed CI
benchmark baseline was updated from these local runs.

The native default pipeline additionally has a [full Revit part audit](native-parts-verdict.json)
in its reported SiteLocal frame. All emitted parts retain their exact edge
incidence; every changed part is closed and coherently paired in both sources.
The reduced vertex count is confined to two parts of host 33639, with unchanged
triangle counts. Symmetric finite surface samples across every changed part stay
within one kernel snap grid. This checks a different frame from the browser
capture, without claiming a new independent reference oracle. The
[collector source](native-parts-collector.rs) calls the exact `process_geometry`
entry and default options used by the native probe; temporarily copy it to
`rust/processing/examples/native_parts_6516.rs` and run the recorded command on
each worktree to reproduce the arrays and frame metadata.

The [scoped revert-oracle mutation evidence](revert-oracle-mutations/README.md)
qualifies reuse and two safety decisions without deleting their test interface.
It does not turn the automatic whole-file compilation failure into an assertion.
