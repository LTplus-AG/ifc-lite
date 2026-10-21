<!-- SPDX-License-Identifier: MPL-2.0 -->
# Raw-leaf memo recovery verdict (#7917)

The optional memo is deferred. It adds decoder state and invalidation obligations without a demonstrated current end-to-end or browser-worker bottleneck benefit. It is not required for the canonical placement-reader reconciliation in #7779. This is a project-scope decision, not an unsafe-code finding.

The recovered candidate is da7bd10975272c8edbfb39d61c0171fe26b65bdb, compared against placement 63129ea719529678250cc4f2ebf1fce3f12997da; the separate placement comparison uses main141285f8287bbc88a420d0ce1168cb7f1a6aa72c. All original PR ancestry, authority/configuration/index replacement tests, raw-parser work counters and prior evidence remain in the branch.

`summary.json` binds the original completed Pop benchmark receipt to exact sources, binaries, phase outputs and raw samples. `retained-evidence.tar.gz` preserves the original receipt, empty launcher log, complete nine-call output witnesses/diagnostics, source bindings and all interleaved timing observations/reports. Hashes inside those original records are unchanged. Five outer rounds with five inner iterations are nested observations, not 25 independent rounds. Selected best-of-five and outer-block median statistics are retained separately; the reporter's inconclusive verdict is retained.

The three real fixture outputs match across all three arms, including ordered meshes, raw float bits, frames, instances and diagnostic bytes. The memo shows a promising Holter parse signal and small native wall reductions for two models, alongside a small increase on the third. These native measurements do not establish a user-visible browser worker-pool benefit, a production memo hit rate, an end-to-end speedup, or neutrality of the separately published standalone placement layers. Original historical measurements remain bound to their original sources.

Revisit only with a new actual consumer profile showing repeated strict raw-leaf parsing materially affects the user-visible load path. Preserve the measured lesson rather than rerunning until a desired result appears. No baseline, ceiling, allowance, pin or tolerance is changed.
