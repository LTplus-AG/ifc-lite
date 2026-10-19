<!-- SPDX-License-Identifier: MPL-2.0 -->

# Ignored-test coverage at a338

This inventory records the 47 ignored entries in the actual successful workspace run at `a338ee79880c560ee1693db91ca68dbc58bc4f49`. It binds every entry to immutable source contents and the archived run output. The same names and reasons occur in the earlier failed 68da run. The workspace result is 6,385 passed, zero failed, and 47 ignored; strict all-target Clippy passed separately.

An ignored entry is not automatically a missing correctness test. One child fixture-gate test is exercised by its passing parent subprocess tests. Other entries include long correctness/resource stress tests, known-failure reproductions, unavailable local models, measurement probes, fixture writers, and illustrative doctests. The inventory records the remaining action for each entry; it does not waive coverage.

Do not run a blanket `--include-ignored`: some entries write reference artifacts, some intentionally reproduce existing failures, and some require unavailable models or special feature/serial execution. Schedule the correctness and resource cases through fleet admission with their documented prerequisites. Run timed probes under exclusive benchmark ownership; they do not replace end-to-end base-versus-branch performance qualification. Do not publish private local fixtures or repin references to turn a failure green.

This audit executes no ignored tests. It provides no actual SDK, browser, WASM, or performance qualification. SDK-gated tests that return early without a configured worker remain missing numerical coverage even when their workspace target reports success. Newer opening and lineage sources require their own executed results.
