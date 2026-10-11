# Capture ownership: #6709 / PR #6711

The canonical animation loop could overwrite a capture between rendering and
readback. BCF could read the active CSS-resolution tween frame directly, and
report exports could lose both their resolution and entity mask while awaiting
GPU completion. Two simultaneous exports could both read the second export's
frame. One shared capture lease now serializes preparation, canonical render,
GPU completion, presentation and readback. The animation loop parks before
camera updates, uploads or rendering while that lease owns the viewport.

Reviewed and checked source: `8aa5309da08c172ba975c7bdb736bf6ccee5f857`.
Integrated main: `2382cf4124315f027b2d33c21c1751cee33c5081`.
Original remote head: `da7d0c81a7633071fce4aec1382c68d63549ae5f`.
The normal main merge is `e73e032a5b5b3bfa7555111f541485e2fc0a6fca`;
baseline test source was subsequently committed unchanged as
`19c4296e9cfd751a0d51e610a9188fac98d62480`.
The commit adding this archive changes evidence only.

## Actual reproductions and corrected observations

The harness mounts the actual `useAnimationLoop` and `useBCF`, calls the real
report capture, drives the real renderer viewport sizing and camera animation,
controls rAF and defers `queue.onSubmittedWorkDone`. The CSS viewport is
600 x 400. Each baseline assertion failed after successful prerequisite builds;
none failed at fixture loading or module import.

| Control | Before ownership | After ownership |
| --- | --- | --- |
| DPR2 BCF during a 300ms tween after two rAF frames | 600 x 400; camera moves during wait | 1200 x 800; camera agrees with rendered frame |
| DPR2 report during navigation | 600 x 400; requested ghost mask lost | 1200 x 800; requested mask `[7]` |
| DPR1 BCF tween control | dimensions unchanged, camera drifts during wait | 600 x 400; rendered camera preserved |
| DPR1 overlapping report control | requested ghost mask lost | 600 x 400; requested mask `[7]` |
| DPR2 with persistent cap 1.5 | capture overwritten to 600 x 400 | capture 900 x 600; resumed navigation 600 x 400; preference remains 1.5 |
| Two deferred report captures at DPR1 | both read mask `[8]` | serialized masks `[7]`, then `[8]` |

The original regression test assertions are unchanged. Later harness changes
add lifecycle instrumentation, canonical section fixture typing and an explicit
return type. The baseline source bytes and their hashes are archived separately.

Six additional invariants cover canonical appearance/clipping/visibility,
ownership during deferred completion, failure recovery, unmount cancellation
during completion and presentation, camera restoration on readback failure, and
rejection of a canvas belonging to another viewport. Existing BCF federation,
overlay-created entity, bound model revision and basket provenance controls also
passed in the broader targeted viewer run.

## Implementation and source coverage

`apps/viewer/src/lib/viewport-capture.ts` owns the shared protocol.
`components/viewer/viewport-render-options.ts` is the single builder used by both
the ordinary loop and capture. BCF associates camera metadata with that rendered
frame. Report, IDS and clash capture use one entity-framing helper; toolbar,
basket and chat captures use the same ownership gateway. Captures preserve
canonical appearance and clipping, explicitly request full detail, respect the
persistent renderer resolution preference, and change no resolution preference.
Entity framing applies the canonical zero-duration camera animation inside the
lease; no exporter timer or second option builder is introduced.

The source receipt pins all 29 changed source/test/API/docs/changeset files
against integrated main, including the original frame-local renderer cap and
navigation lifecycle. Reviewed interactions include gestures/inertia/tweens,
settlement, buffer resizing, CSS picking and measurement projection, every
affected capture caller, model resolution and overlay-created selection. This
is affected-path review, not a claim to audit every renderer/viewer line.

## Checks and provenance

All test/typecheck invocations use root Turbo and serial execution. Raw logs,
source receipts and SHA-256 indexes accompany this receipt.

- Baseline at main-merged production plus the two pinned test files: six
  assertion failures, zero passes or skips, 53 prerequisite tasks successful.
- Corrected source `f821e8529bb7a93a90ae6a350ea9b1fe999d854a`: targeted viewer
  154/154; renderer 2050 passes, two optional skips; 55 Turbo tasks successful.
- Canonical section fixture correction at
  `21d58cd1a7ea0e3b18bab6e7330b1cec62866728`: 12/12 capture tests, no skips.
- Source `8aa5309da08c172ba975c7bdb736bf6ccee5f857` adds a type-only harness
  result annotation. Full root `pnpm typecheck` passes 119 tasks and audits
  all 3865 test files in 62 packages; its final performance-script check passes.
- Root lint, module size, source-text assertion, frame-wait and test-wiring
  gates pass. API-surface check initially stops on missing declarations; a
  bounded root Turbo build of five TypeScript packages succeeds (47 tasks),
  followed by a successful API gate without changing its snapshot.

The two initial typecheck failures are retained: incomplete section fixture
typing, then inferred private hook result leakage in the exported test harness.
Neither changes production behavior. The full root typecheck script cannot
forward a Turbo concurrency argument to its first command, so execution used
the supported top-level `concurrency: "1"` setting temporarily. Both exact
configs are archived; the dependency graph and acceptance checks are unchanged;
original config restoration is verified for every run.

Earlier hosted CI failures are diagnosed in the retained log/receipt. Current
main was merged normally; unrelated assertions and acceptance were not edited.
Local root typecheck and lint now pass. Fresh final-head hosted CI and review
remain independent requirements.

The corrected cohort used reservation
`1905f337-e1fc-4739-80af-da6b1f26fc58`, acquired only after recorded #6537
release. All owned processes exited normally; zero owned browsers or servers
were started. Actual cleanup was recorded before releasing the matching lock
at `2026-10-09T16:02:09.477072+00:00`. No foreign process or fixture was touched.

## Acceptance boundary and next step

This is integration evidence. The GPU queue is controlled and actual rendering
stops at the context boundary before GPU command encoding. Canvas readback
returns a JSON observation sentinel, not a physical PNG. It proves the canonical
resolution/camera/options ownership protocol under the demonstrated interleaving;
it proves no GPU image, mesh image equivalence, CSS picking result or frame rate.

The earlier `untimed-fzk-cpu-20261009` archive remains qualified CPU geometry,
owner and placement identity for one unedited primary model. It is not upgraded
by these tests into GPU, overlay geometry or performance evidence.

Still missing from #6709 completion: real public-model/native-GPU interleaved
navigation comparison including transition frames, physical DPR2/DPR1 controls,
real CSS picking, sharp idle and capture images/dimensions, an idle-window
navigation performance verdict, successful fresh final-head CI and resolved
review feedback. No #6516 loading-regression claim is made. The PR stays draft.

Bounded next step: obtain a separately coordinated physical GPU window; use the
pinned base/head and one freshly loaded public FZK model per arm, interleave DPR2
navigation/transition/settle/BCF/report captures with a DPR1 control, record actual
device identity, PNG dimensions/images, CSS picks and transition costs. Keep
performance acceptance open until a measured idle A/B comparison is available.
