# Alignment section default-load evidence (#6603)

The retained axis worker opens only after explicit alignment selection. This
control compares the ordinary, canonical viewer load path against its shared-core
parent, with fresh matching WASM and JavaScript bundles on both sides. The core
metadata-only API snapshot follow-up does not change the baseline runtime.

[measurement.json](./measurement.json) retains all ten successful final samples,
source/runtime/fixture hashes and preceding qualification failures. Timings use
five interleaved fresh Chromium processes per side, with Haus loaded first and
an empty application cache. Geometry streaming uses the actual worker pool.

The final output witness matches across every sample: sorted model-local entity
IDs plus FNV-1a hashes of flat position, normal and index byte arrays, and float64
color/origin values. Canonical per-entity geometry hashes also match, including
instanced entities. Sorting excludes worker completion order from the witness;
the witness executes after the measured completion boundary. This is not a hash
of rendered pixels or of every GPU instance transform.

All measured phases stayed within the reporter's variation estimate. The result
supports no observed default-load regression in this model and environment, and
makes no speed claim. Background Chrome processes could not safely be stopped,
so this is not an idle-host proof. An earlier baseline-only renderer timeout is
retained alongside subsequent harness failures; it is not silently converted
into a successful sample. Independent inspection found that its screenshot
rendered Haus successfully. Late renderer initialization missed the streaming
transition that emits the finalization marker demanded by the timing observer;
the timeout is an observer false negative, rather than evidence of failed rendering.

To repeat the standard timing control, build frozen viewer distributions at the
recorded refs, then use `scripts/perf/browser-cold-ab.mts` with `--dist-base`,
`--dist-branch`, `--iters 5`, the Haus fixture and one explicit browser executable.
The additional payload witness was collected from the canonical viewer store
only after timing, without altering the loading or geometry path. The temporary
harness supplied tsx's serialized-function name helper after timing as well.

The actual production viewer selected axis #39 in the original OIP 2017 model
`844_terrain_and_alignment.ifc`, moved through distances 0, 10 and 20, and retained
flip. The section point matched the independent circular oracle. Closing retained
the exact custom plane and flip while releasing its binding; explicit selection
reacquired station 0. [The captured viewer](./oip-station20.png) shows distance 20.

Two surgical regression controls retain the public APIs and real WASM fixture.
Removing the busy distance-queue guard fails directly with an extra RPC before
open acknowledgment. Forcing same-owner reopening to enable the cut fails the
disabled-Cut invariant. Both restore to a passing controller suite. The station
RPC-count assertion precedes awaiting its promise, so the first defect is detected
without waiting for the request timeout.

[Supported reverse patches and verdicts](./mutation-proofs.json) retain every changed test seam and verified restoration; they replace the whole-feature compiler failure, under the [maintainer’s documented exemption](https://github.com/LTplus-AG/ifc-lite/pull/6609#issuecomment-5929292510).
