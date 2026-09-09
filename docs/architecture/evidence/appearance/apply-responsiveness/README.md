# Appearance Apply: trusted input acceptance (#4336)

Three interleaved fresh-Chromium pairs compare main `946e60f0d` with the same source plus fresh background `scheduler.postTask` scheduling in `prepare-plan.ts`. Both use the identical WASM artifact, fixtures, browser and viewport. The only other branch code is an allocation/work-budget regression test, which is not loaded in the browser. Initial historical synchronous experiments are excluded from this comparison.

| Run | Main Apply ms | Background Apply ms | Main input roundtrip ms | Background input roundtrip ms | Main longest task ms | Background longest task ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| a | 3883.4 | 4183.3 | 3800 | 17 | 808 | 797 |
| b | 3909.8 | 4261.8 | 3833 | 17 | 815 | 812 |
| c | 3881.6 | 4237.1 | 3805 | 12 | 781 | 829 |

The median trusted-input roundtrip changes from 3805 ms to 17 ms. Main delivered every measured wheel event after Apply completed; the branch delivered every event during preparation. Median Apply elapsed time increases from 3883 ms to 4237 ms (about 9%). This is an interaction improvement, not a throughput win. The final exact synchronous transaction fence still produces a visible pause: median longest task is effectively unchanged, 808 versus 812 ms. The recorded maximum frame gaps likewise remain around 0.8 seconds.

## Workflow and measurement

Open public `convento.ifczip` and add the unrelated `untextured-wall.ifc` through the existing loader. Author → Appearance → Entire model, upload `boulder_01_diff_1k.jpg`, use planar XZ mapping, wait for Preview ready. Each run uses a fresh browser with actual WebGPU. No builds or other acceptance browser runs from this lane overlap the measured Apply. Other repository agents were active on the shared development machine, so these are observed paired interaction results, not isolated-machine throughput guarantees.

A capture-phase listener timestamps the real Apply click before its handler and emits a console event to the external driver. After receiving that event, the driver waits 100 ms and sends a trusted CDP mouse-wheel event at viewport coordinates (800,550). The DOM listener records `isTrusted` and delivery time. The reported roundtrip includes protocol transport; delivery timestamps independently establish whether input reached the page before completion. This avoids synthetic DOM `.click()` and avoids sending the wheel over the Apply button in the dock.

A mutation observer pins the first Appearance-applied notice. The later scope refresh can replace that notice, so it is not required to stay continuously visible. Long tasks and frame gaps are included when their time intervals overlap Apply, including the first frame after completion. Source/fixture/runtime SHA-256 values and raw timing records are in `summary.json` and the adjacent files. Raw JSON is compact to keep machine evidence small.

Every run performs actual ribbon Undo and Redo and checks the unrelated wall remains unchanged. Runs b/c also compare sorted owner/item/mesh-buffer fingerprints, ignoring streamed mesh order: Undo restores the original parts, Redo restores authored parts, and baseline/branch authored fingerprints agree exactly. All runs restore the exact ordered Apply fingerprint on Redo. Screenshots were inspected; `applied-redone.png` includes the asynchronous post-Redo scope refresh.

## Cancellation and memory

The branch also receives a trusted click on the actual enabled Discard button after Apply starts. The captured click occurs while the panel says Preparing IFC changes and completes in 63 ms. Both models retain their original buffers; no authored entities or Undo entries are published. `cancel-cancelled.png` shows the original Convento appearance restored. This exercises real queued input, unlike the earlier phase-triggered synthetic DOM click.

Chromium `Runtime.getHeapUsage` after explicit GC reports used JS heap of about 193.3 MiB before cancellation and 112.7 MiB afterward. Completed paired runs retain roughly 253–259 MiB after GC. `performance.memory` samples on animation frames are coarse, miss allocations within a synchronous task and exclude WASM/GPU/process memory; they are observations, not peak-memory bounds or a no-leak proof. Raw CDP records separately include backing storage and embedder heap.

The existing 2 GiB cumulative allocation and 32 million work-step limits remain unchanged. They count private copies over the job, not simultaneously live memory. A host-command regression deliberately exhausts each bound and asserts unchanged IFC, history, GPU and image ownership. The final synchronous fence cannot be interrupted once entered; no universal frame-time guarantee is claimed.

The Browser skill connection returned “Browser use requires a trusted Node REPL browser service”; acceptance used the existing local Playwright fallback. All owned Chromium instances and viewer servers are closed after acceptance.

Re-run `tools/texture-authoring/measure-appearance-apply.mjs` and `exercise-appearance-cancel.mjs` with `APPLY_URL`, `APPLY_OUT`, `APPLY_IFC`, `APPLY_OTHER_IFC` and `APPLY_IMAGE` pointing to the viewer and downloaded fixtures. These are manual acceptance journeys, not CI gates.
