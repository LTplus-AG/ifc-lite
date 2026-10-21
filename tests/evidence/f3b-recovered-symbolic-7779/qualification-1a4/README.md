# Current consumer qualification: source 1a4be7e61a

The user authorized a long-running goal to complete qualification and shepherd
the existing stack to merge. Parent ownership remains with session 5be21541;
session bf7d2a91 retains #7914. This packet is interim evidence, not merge
acceptance or completion of the charter.

The branch carries the parent's latest placement WASM contracts and evidence.
Its Rust, viewer and package production inputs remain equal to the native
qualified source in [reconciliation-6fa](../reconciliation-6fa/README.md).

[Current consumer progress](consumer-progress.json) records successful root
build/typecheck and initialized real-WASM contracts. The full root test graph
is still running. No whole-graph pass or source-after result is claimed.

[WASM source/build identity](wasm-build-source.json) retains the original actual
compilation from this checkout. That first job failed later because Turbo was
not installed. A second admitted job installed the frozen lockfile dependencies
and passed the recorded stages. Its fast cached WASM build is backed by that
earlier source-identical compilation; it is not presented as fresh compilation.

[Browser numeric summary](browser-summary.json),
[complete output](browser-result.json.gz) and [screenshot](browser.png) show the
actual frozen WASM extracting the public real-model axes against the independent
IfcOpenShell placement/curve oracle. The zero-span compatibility control passes.
Every handle was freed. Input and runtime hashes were verified in the browser.
The red curve is explicitly the historical baseline, not a newly measured arm.
The preview's WebGPU API returned no adapter, so this verifies the WASM/canvas
boundary and does not claim canonical viewer GPU rendering. Repository viewer
E2E tests are separately queued on the PC worker.

The [finite measurement plan](measurement-plan.json) is frozen before timing.
Its results remain pending; earlier measurements are not reused. The separate
Class R neutrality hold on #7896 is not waived by #7914's correctness evidence.
