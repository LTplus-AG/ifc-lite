# Mesh owner cache and renderer packing evidence (#6537)

The historical source-matched public-model loads were driven through the actual T3 shared
browser and the canonical viewer file input. No scheduler, loader or producer
was replaced. Source, build, runtime and fixture hashes are retained with every
sample or provenance record. The unchanged WASM runtime is newer than the Rust
sources in both final builds.

## Current-main reconciliation (#6584)

The historical records below remain tied to their original frozen sources; they
do not qualify the current candidate. Main #7021 already stamps a single model's
own array in place, so that shipped identity and per-append optimization is kept.
The old general owner-cache implementation is superseded here.

Actual root Turbo mounted controls on main `e0053d137a` reproduced seven CPU
release failures while all six existing single-model controls passed. Restoring
the old revision mechanism fixed immediate/batched release cases, but failed
retained copies after an earlier recolour and canonical copy ownership controls;
it also failed the in-place edit and append-cost controls that main now requires.

The current fix registers only CPU-sharing shallow copies through
`carryReleasedMesh` and empties reference-identical fields through the canonical
release action. Weak keys, weak members, pruning and weak finalizer holdings
avoid retaining discarded copies. Independent updated fields survive. Retained
counts recover only for exact zero-byte field references assigned by release;
legitimately empty replacement fields never inherit old counts. CPU release
preserves the renderer's geometry content version and global append prefix.

All 84 relevant root Turbo controls pass, including repeated batched release,
release with replacement/clear, earlier recolours, shared versus independent
fields, provenance/counts and a real isolated GC witness. The GC witness collects
three generations of discarded copies while retaining the source, then collects
released position/normal/index arrays while retaining a copy. This establishes
collectability and reference removal, not an OS peak-memory or throughput number.
Plain full root typecheck covers all 3708 test files across 62 packages.
Four additional red-before controls demonstrate the replacement-count, colour
reset, appearance-source and placed-copy defects before the shared helper fixes.

The existing canonical loader harness also loads the unmodified real Bonsai
`hello-wall.ifc` as primary and peer through `useIfcLoader.loadFile`, using the
actual WASM engine. Both produce eight meshes with identical geometry hashes;
the actual viewport filter retains five visible primary meshes. Releasing the
active source after recolour empties retained original/viewport copies and
preserves scalar counts, IDs, content version and the peer's byte hash. This is
an engine/store/mounted-hook proof in Node, not a GPU frame or browser timing.
[Exact qualified sources, runtime/fixture hashes and raw logs](current-main-release/qualified-source.json)
include the failed visible-count harness assumption and earlier counterexamples.
No current end-to-end speedup is claimed.

## Historical verdict and limits

The direct renderer packing candidate remains unshipped: these measurements do
not demonstrate an end-to-end benefit. The owner-cache candidate removes
repeated prefix stamping and preserves released-buffer semantics, but no normal
foreground speed improvement is established. Both experiments retain their
negative and noisy samples. The original packing verdict predates the frame
cadence diagnostic below and must be read with that limitation.

The identical animation-frame sampler in the third Holter owner-cache pair
found approximately one frame per second on both builds. An empty viewer has
the same cadence, while the preparation page receives frequent frames. The T3
preview reports hidden even though document visibility reports visible. The
adapter is a real NVIDIA device, not a fallback. A long post-stream queue tail
in this environment cannot identify product main-thread/GPU CPU cost or stand
in for foreground user readiness. Verify actual foreground frame cadence
before further timing qualification. No instanced GPU byte hash is claimed.

Retained flat-mesh positions, normals, indices and appearance fingerprints
match for the small AC20, CSG-heavy Holter and larger O-S1 inputs. GPU residency
allocation totals vary on unchanged code too; they are not a byte oracle.
Source buffers and stable owner indices are verified independently by mounted
hook tests, including immutable replacements, point-cloud chunks, model count
and visibility transitions, and the actual store CPU-release action.

## Inspect the raw records

`raw-observations.json.gz` is a deterministic gzip archive of records with
original name, SHA-256, byte count and parsed JSON value. The manifest is
readable without decompression. It preserves the initial packing samples and
the partial owner-cache A/B series; neither is a complete representative
foreground performance verdict. The frame-sampler pair is explicitly distinct
from earlier samples without that sampler. No baseline file was overwritten.

```python
import gzip, json
from pathlib import Path
records = json.loads(gzip.decompress(Path("raw-observations.json.gz").read_bytes()))
for record in records:
    print(record["name"], record["value"].get("geometry"))
```

Original JSON whitespace is represented by its hash; the archive stores each
parsed value losslessly. Source worktree paths are capture-time provenance,
not required install paths. Performance ledger conclusions are narrative;
these records contain the measured values and their qualifications.


## Independent base reproduction of the memory defect

The actual base hook and owner helper were restored together in an owned
worktree while running the new mounted tests through root Turbo. Seven tests
passed and two failed: single-model appends copied the prefix again, and a
federation retained buffers after the canonical store release action. The
base single-model release case passed, narrowing the pre-existing memory
defect to the federated cache. Restoring both candidate files byte-for-byte
makes all nine tests pass, without a geometry-content version bump that would
request a GPU reupload of released arrays. Both real logs are archived. This
is correctness evidence independent of the unqualified browser timings.


## Batched release and retained aliases

Independent review reproduced a release followed by append in the same React
batch: the original same-length trigger misses the release. A forced rebuild
then exposed a second defect: appending to an earlier federation owner reorders
the global prefix already consumed by the uploader. Replacement, recolor and
clear actions also exposed retained wrappers that were discarded before their
CPU arrays could be emptied. The three genuine failing runs and subsequent
passes are retained in `release-regression-logs.json.gz`, with original hashes
and exact counts in `release-regression-manifest.json`.

The correction uses one canonical CPU-release primitive and a weak source-array
revision. The hook checks its previous sources and empties their previous owner
wrappers before replacement or teardown can discard them. A release followed
by append keeps the global prefix and adds only the new suffix. Retained counts
and appearance provenance survive repeated releases; GPU content version stays
unchanged. Mounted tests cover single and federated models, successive releases,
recolor, peer replacement and clearing the federation. These are correctness
claims, independent of any timing result.

The corrected source was integrated with base `3e2779997ae165c36f6939419f9229debc73c163`
and built as `ffa087d031df2f48d57fd216aa8d00b783dfd8c4`. Full root build and
typecheck passed, followed by the streaming, federation, translation, data-slice
and memory suites. Both comparison builds have byte-identical WASM runtime,
glue and committed types. The earlier hidden-preview observations remain
retained and are not promoted to a foreground performance verdict.


## Foreground observations after visibility was restored

`foreground-observations.json.gz` and its manifest retain five interleaved
base/branch pairs for AC20 and Holter, on the real non-fallback NVIDIA adapter
with stable foreground frame cadence. Each model was the first canonical load
in a newly navigated document with all application caches cleared. These runs
reuse the same T3 tab; literal new-tab and same-build noise controls, plus the
larger O-S1 model, remain pending. The small differences do not establish a
universal speedup. Both builds retain identical flat geometry fingerprints,
mesh and triangle counts in every pair.

Three interrupted automation attempts are separate diagnostic records. The
large-file remote polling timeout did not prevent the actual viewer from
finishing the load; those attempts are excluded from the paired series. Holter
uses a post-final in-page readiness observation to avoid that control-path
timeout; each fixture's two builds use identical instrumentation. Preparation,
fixture download/hash and the deferred remote wait are outside the measured
finalization interval. Neither these timings nor the original hidden runs
claim complete instanced-GPU byte identity.

Standalone Chrome was also tested: it has normal frame cadence on this Linux
host but software graphics and no WebGPU adapter. The shared T3 browser has the
real NVIDIA adapter and is used for rendering comparisons. Both diagnostic
records are retained; they are different graphics environments.


## Partial literal fresh-tab control

`fresh-tab-observations.json.gz` retains one completed AC20 base/branch pair in
two newly created browser tabs, with matching retained geometry and foreground
cadence. The companion manifest marks this as an incomplete series: one pair
cannot establish a speed difference or replace the five-pair document controls.

Later attempts failed in native browser cache preparation before a model was
loaded. Those automation connection errors are separate diagnostic records and
are excluded from timing samples. The original successful pair closed its owned
tabs after capture; the retained current protocol shows the subsequent recovery
attempt that kept tabs alive, with bounded idempotent preparation retries.
Neither recovery completed another model load. There is no fresh-tab O-S1
result or same-build noise verdict. The source and previous evidence archives
are unchanged.


## Fresh-process Chrome CPU controls

`chrome-cpu-controls.json.gz`, its manifest and readable summary preserve forty
user-authorized Chrome samples: five same-build AC20 pairs and five interleaved
base/branch pairs for each of AC20, Holter and O-S1. Every sample starts its own
browser process and loads the target IFC first through the actual viewer file
input. The browser is Chrome 153 with Google SwiftShader. All retained flat-mesh
positions, normals, indices and appearance hashes match across every pair.

This observation stops at actual worker-stream completion and metadata publication.
Those phases overlap and their durations must not be added. It does not wait for a
rendered frame or establish renderer readiness, cache reopening, full-lifetime
memory or a GPU speedup. The unchanged geometry worker and WASM hashes are pinned
in the manifest. The same-build control exposes timing variability, and the
base/branch results do not establish a consistent broad speedup. All three models
are ARCHICAD exports (20/21), not three independent authoring tools.

The captured runner and static server are retained beside the data. Their paths
identify the original frozen worktrees and local fixture catalog; adapt those
paths to reproduce on another host. Start the server over the two frozen viewer
distributions, then run `node chrome-cpu-capture.cjs`. The runner refuses to
overwrite existing results, closes each owned browser, and stops after retaining
an invalid sample. The initial attempt had an optional-render-stats observer
ReferenceError; it is not a model failure or a valid timing sample, and is
excluded from this independent complete schedule. No CI baseline was changed.

The source-frame replacement follow-up in [source-frame-replacement](source-frame-replacement/README.md) preserves a genuine dropped review finding and its actual canonical counterexample. Weak historical ownership corrects registered copies across source restoration without retaining old allocations; current raw controls and source/runtime hashes remain separate from earlier qualification.

The [immutable history carry](immutable-history-carry/README.md) follow-up preserves the next genuine dropped finding: immutable recolour after source-frame restoration changed the release owner. Independent flat weak snapshots fix that sequence while preserving unrelated replacement fields. Its source/control receipts also preserve the WASM artifact identity change observed during subsequent typecheck.
