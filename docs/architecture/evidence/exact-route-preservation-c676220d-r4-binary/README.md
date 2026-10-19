<!-- SPDX-License-Identifier: MPL-2.0 -->
# Saved executable binding — separate first repair

Incremental repair of review item 1 on frozen `c9d3c7cba0`. All older evidence and
the 117-pass record remain unchanged. No heavy job, Rust build or real IFC capture
was run, and the parent's tree, target/cache and active work were not changed.

The runner derives the expected executable digest from the compiler artifact hash
map that has already matched the successful terminal compiler trace. It copies
that executable exclusively into a private output directory, makes the copy read/
execute-only, and verifies its bytes against the terminal digest. It executes
**the saved copy** for every fixture. Before and after each child execution, and
at final completion, it verifies the saved bytes again. A shared-target replacement
before/during copying refuses; replacement after copying cannot select the executed
file. The receipt comparator requires the saved path/digest and per-capture
execution provenance to match that actual terminal compiled artifact, not merely
a self-consistent receipt hash.

Forty-six small Node protocol tests passed, zero failed/skipped. The executable
fixtures are tiny Node scripts, not Rust/geometry builds: they show that replacing
the shared original still executes the original saved bytes, wrong pre-snapshot
bytes refuse, and saved-copy mutation is caught after execution. An independent
receipt fixture replaces the actual saved file and rebinds its binary/fixture
hashes and synthetic fleet marker while preserving compiler evidence; comparison
refuses. Full TAP, source hashes and scoped patch hashes are retained here.

This commit repairs binary binding separately. Workspace graph reconciliation is
the next repair; actual A/B and independent closure remain pending. The v2 raw
capture consumer/default arithmetic and nonempty-instancing/federation requirements
are unchanged. Commands and independent Git/fleet procedure remain those of r3,
using this manifest for this intermediate freeze.
