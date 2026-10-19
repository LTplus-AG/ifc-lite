<!-- SPDX-License-Identifier: MPL-2.0 -->
# Browser retained dependency checkpoint

Source checkpoint: `df8ff4fd4676fc4cf4bb6a65d37ebcefaa9228dc`, based exactly on `1aceb23744dd9d37b45a7b8354f57dabae4c6c23`.

This is substantive runtime implementation, **not completion of common retained
execution**. Common slots, transaction acceptance and final-net/appearance closure
remain unimplemented. Exact remains permanent/default. No engine cutover,
SDK runtime qualification, full heap coverage or performance claim is made.

The explicit browser constructor enables independent per-object leases. Sealed
Boolean results are produced by the imported actual driver using ordered operands
and owned f64 coefficients; inputs are copied before transform, temporary objects
are released, and results retain independent actual object leases. Healthy release
invalidates the exact lease before asynchronous release. Unknown failures retire
only the captured owner. Source-only constructor/drop/qualification stays selected
by default. Native f64 frame and lineage code is shared without changing native
semantics.

`owned-paths.patch` contains the complete 14-path incremental source patch.
`source-hashes.json` records base/source trees, before/after Git blob identities and
working-file SHA256 values. `checks.json` names each actual lightweight command
and its raw log. Six actual-driver protocol/lifetime fixtures passed using a
fixture transport; they provide no SDK numerical evidence. Rust parsing passed
for nine edited files; no typecheck/build was run. Five actual browser Rust tests
exist and remain unrun. CTest wiring was inspected as source, not configured/run.

See `qualification.json` for all residual work and explicit non-qualification.
No heavy jobs, external publication or foreign-job cleanup occurred. Parent router,
mapping cleanup, processing resource/session and presentation-test changes are
outside this patch and must be preserved when merging.
