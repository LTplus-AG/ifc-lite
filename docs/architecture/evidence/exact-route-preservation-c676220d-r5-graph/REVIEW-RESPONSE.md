<!-- SPDX-License-Identifier: MPL-2.0 -->
# Response to frozen c9d3 closure review r4

Review task supplied by parent:
`exact-capture-c9d3-closure-review-20261019-r4`.

1. Binary provenance repaired separately in `3a1e7f7b127741e3117f3d2e8fc302ff2e9caf57`.
   The terminal compiler artifact hash is now required for the actual saved bytes;
   the saved copy is executed and rechecked after each capture. Actual file
   replacement with rebound binary/fixture/receipt/fleet hashes refuses while
   terminal compiler evidence stays unchanged. Forty-six targeted tests passed.
   Its immutable source patch SHA256 is
   `9ad37c3ba69ca2b9e9adfc2ce9114741a4d1d720de46ac0fa23fa0f63f0ac29a`.

2. This separate layer reconciles differing reached workspace graphs only through
   an independently pinned exact source/unit/policy/edge witness. It supports
   additions and removals, keeps every unit's compiler provenance, checks all
   common workspace policies, and requires explicit exact external transitions.
   The intended source manifests/lock/tree pins and native edges are retained in
   `source-graph-plan.json`. Drafting an observed graph cannot authorize it; the
   parent independently reviews/freezes its literal expected contents and digest.
   Tests demonstrate accepted intended workspace graph changes and refused
   unknown additions, unlisted external changes, changed common settings,
   reordered common edges and false source/policy pins with identical captures.

3. Source-evident Cargo fixture shapes now include copied host build-script
   executables, shared proc-macro libraries and the reserved bare proc_macro
   sysroot extern with explicit actual-compiler query/byte provenance. Unknown
   bare externs and missing/changed toolchain-library traces refuse. Real Cargo
   host/proc-macro builds and duplicate host/target units remain unproved.

Final small Node fixture suite: 148 pass, zero fail/skip. No heavy validation or
real A/B was attempted. c9d3's 117-pass record and all prior evidence remain
immutable. No parent's source, cache, config or active job was touched. Independent
closure and real admitted capture/witness review remain required. Original-base
compile repairs, if needed, must remain separately identified reproductions;
nonempty instancing and federation are not waived. No no-regression, full-no-loss
or timing result is claimed.
