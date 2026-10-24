# #8042 v3 lower native/lossless stack

Preparation base: merged #8081 main `208f8e130b55e4a563b82b8b75486eb53860cf0d`
(Rust 22.5, aligned lock, validated raw JSON bridge, scalar fingerprint and comparison guards).
Read-only integration reference: `54efddcc816a683766bc7daa4024aceb57999844`.
The active reference checkout and old completion checkout are never modified.

This stack is prepared in `/home/louistrue/dev/ifc-diff-lower-v3`, a new Linux
clone with its own Git metadata (local object alternates to the source clone).
The v2 refs and all parent refs are preserved. No parent merge, push or PR.

Qualification for every layer is SOURCE INSPECTION ONLY: scoped diffs, native
source identity comparisons and `git diff --check`. No builds, tests, Cargo
metadata, Clippy, toolchain commands or declaration generators were executed.
Parent qualification of the integrated tree does not qualify these layer trees.
All committed WASM declarations remain byte-identical to the known staging base
until the parent regenerates them; no generated ABI equivalence is claimed.

## Layer 1: shared lossless document

`stack/8042-v3-lossless-document` depends directly on the preparation base.
Expose the existing code-unit string/document representation and integrated serde
implementation. A typed serializer marker represents non-scalar strings, never
an object-key escape convention. Scalar human-readable serializers reject lone
surrogates. Shared identity/order/serde invariants are split into
`rust/diff/tests/document_utf16.rs`; engine-dependent tests arrive in layer 3.
The reference's default/empty identity regression is included here too.
Production source is extracted unchanged from the integration reference via v2.

Parent must run native document/sidecar tests and strict workspace Clippy on
this exact commit. Rebuild the independent diff payload and regenerate committed
declarations through `scripts/build-wasm.sh` before claiming actual WASM parity.
No binding signatures, public TypeScript exports or consumers change here.

## Contracts retained in every lower layer

Staging's validated `diff_sidecar.rs` raw JSON syntax bridge and its existing
actual WASM syntax/literal-surrogate tests remain unchanged. Invalid scalar
JSON retains the legacy string error, while invalid non-scalar JSON retains the
host SyntaxError. Do not substitute a bounded DTO reader for raw JSON parsing.

Keep the staged lineage scalar rejection guard and the actual WASM lineage
rejection/collision/accepted-scalar tests through all three layers. The later
operation-specific lossless lineage observer must replace that guard and its
obsolete rejection tests together. Native lossless support alone does not
justify removing the staged guard. Column adapter scalar guards also remain.

All production TypeScript, including the public index, adapters and consumer
initialization, remains at staging. Full facade/observer/oracle relocation and
consumer cutover belong to the later parent layers.

## Main #8081 restack

The merged main base supersedes the historical staging hashes above. Preserve
`diff_input.rs` and the raw constructor/options rejection and once-getter
regressions in layers 1–2. Layer 3 replaces both decoding call sites with
lossless transport, removes that staging module/file, and replaces rejection
assertions with actual WASM/TypeScript parity. Column and lineage guards retain
their separate later removal boundaries. No build or test was run in this restack.
