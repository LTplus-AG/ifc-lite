<!-- SPDX-License-Identifier: MPL-2.0 -->
# Remaining P2 response: dependency policy and cache provenance

The source repair extends `compilerEvidence` from its example-only subset to every
reached Cargo compiler-artifact. `exact-route-units.mjs` validates each full profile,
features and terminal invocation against actual source/config/toolchain/artifact
fingerprints, then compares all paired policies and link relationships. Required
critical workspace crates are explicit. External dependencies receive the same
checks and matching source fingerprints. Raw arguments are retained, with only
declared relocation/hash normalizations in their compared policy.

`exact-route-rustc.mjs` now records successful terminal compilation, package inputs,
generated OUT_DIR inputs, inherited Cargo configuration, extern bytes and output
bytes. The run/receipt tools bind the compile context to the independently checked
Git/fleet source and reconstruct the dependency records from original raw logs and
artifact hashes. Matching example policy or matching example output cannot stand
in for a dependency's policy.

Cached artifacts are explicitly unqualified: no retained compile-trace importer is
implemented, and every `fresh: true` unit refuses regardless of matching profile
or an asserted trust label. No managed cache was disabled, cleaned or bypassed,
no dependency sources were touched to force rebuilding, and no foreign config or
active job changed. Unpaired/ambiguous dependency cohorts also refuse and remain
visible holds, rather than becoming exemptions.

The final eligible pure Node protocol run passes 117/117 with zero skips/failures.
Its paired negatives preserve scene/example values but vary geometry/processing/
external policy; internally consistent receipt/hash mutations still refuse. Cache,
source/config/toolchain/terminal output/link/generation negatives and all previous
schema/Git/fleet/raw-field negatives also pass. TAP output and exact source hashes
are retained in this correction. Small synthetic fixtures are never presented as
real Cargo, fleet or model evidence.

Checkpoints `7368cb32e9`, `ec8020e817` and their evidence are untouched. No heavy job,
Rust compilation or actual A/B was run; the parent Rust task was not duplicated.
Independent closure remains pending. Full no-loss, permanent exact default,
nonempty instancing and actual federation are unchanged requirements, with no
no-regression verdict or timing claim.
