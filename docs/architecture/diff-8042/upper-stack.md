# #8042 v3 upper stack preparation

Preparation baseline: `fe0697077a9d63fbb984d4fc9dcfe405b4115563`
(lower native/lossless engine), descended from staging
`5408a0c42b4817b5814d0d5f80797464d1bad2e8`.
Exact integrated source: `66b1a2371f18243e4623b6a1406db23a5adf6c10`.

Prepared locally in `/home/louistrue/dev/ifc-diff-upper-v3`, an independent
Linux clone with independent Git metadata. Parent and reference checkouts,
original refs, running qualification and worker operations are untouched.
No builds, tests, typechecks, Rust/toolchain commands, declaration generators,
heavy jobs, pushes or PR operations were run. Qualification below is pending;
Git source comparisons and whitespace checks are not runtime evidence.
Full54 qualification reported by the parent does not qualify these layers;
the parent reports the latest full66 initialization-race qualification running.

## Layer 4: host observations and lineage guard replacement

`stack/8042-v3-host-observers` builds on the lower engine ref.
All `rust/diff-wasm/src` now matches full66 exactly. Shared caught host
operators, normalization, lineage, provenance and sidecar observers arrive
as one binding contract (including every consumer of the shared operators).
Separating the shared host module here would leave unused private helpers
under strict Clippy; the complete binding change fits the production budget.
No algorithm is reimplemented. The validated raw JSON bridge remains intact.

The staged scalar lineage rejection and its obsolete rejection tests are
replaced together by the integrated operation-specific lossless observer and
actual WASM lineage corpus/lone-code-unit tests. The existing public TS index
continues using its original engine until the facade cutover. The direct
`wasm-lineage` adapter and provenance projections match the new live ABI.

Parent must build the independent diff payload with `scripts/build-wasm.sh`
and commit its actual generated declarations on this layer before typechecking
against the new exports/signatures. Tracked declarations deliberately remain
at the preparation baseline here: no generated ABI equivalence is claimed.
Run native workspace tests, strict workspace Clippy, root pnpm/turbo checks,
and actual WASM raw JSON, fingerprint and lineage tests. Ensure payload tests
execute rather than skip. The facade observation tests join the oracle
relocation/cutover layer, where their test-only imports become available.
