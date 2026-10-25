# #8042 v3 lower native/lossless stack

Preparation base: merged #8081 main `208f8e130b55e4a563b82b8b75486eb53860cf0d`
(Rust 22.5, aligned lock, validated raw JSON bridge, scalar fingerprint and comparison guards).
Read-only integration reference: `54efddcc816a683766bc7daa4024aceb57999844`.
The active reference checkout and old completion checkout are never modified.

This stack is prepared in `/home/louistrue/dev/ifc-diff-lower-v3`, a new Linux
clone with its own Git metadata. No existing checkout was relocated.
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

## Layer 2: fingerprint typed projection and shared host strings

`stack/8042-v3-lossless-fingerprint` depends on `430374fa` (layer 1).
Fingerprint DTOs, code-unit JSON writing, ordered component entries and the
57-case UTF-16 native vector corpus arrive together. `diff_fingerprint.rs` and
`diff_fingerprint_input.rs` match full54 exactly. The latter replaces staging's
scalar rejection with the full lossless typed projection, reading only known
fields (including deliberately ignoring type assignment globalId and record
extras). Each typed/nested field is observed once. It calls the shared
`diff_transport::string`: checked scalar bulk copy, raw code-unit fallback.

Remove obsolete fingerprint scalar rejection tests together with their guard.
Positive actual WASM tests from full54 cover all typed boundaries, lone-unit
identity, component key order, nested values, Map entries, ignored extras and
single reads. Their only adaptation uses staging's unchanged public TS
fingerprint engine as oracle; private oracle relocation is a later cutover.
The rest of the staging raw JSON test file is byte-for-byte unchanged.

Only used shared string/output helpers are introduced here. General bounded
DTO document/from_value/to_value helpers wait for their first model/lineage
consumer in layer 3, avoiding unused private code. No observer/normalizer or
public facade cutover is pulled into this foundation.

Parent qualification: native document/fingerprint/sidecar tests and strict
workspace Clippy; `scripts/build-wasm.sh` to build the independent diff payload
and regenerate declarations; root pnpm build dependencies, then root pnpm test
through turbo (including actual WASM fingerprint/component order, one-read,
ignored-extra, Map and raw JSON syntax tests). Ensure WASM tests actually run,
not skip because the independent payload is absent. Declarations stay at base
pending generation; no public TS production code changes.

## Layer 3: native model/options/results and raw model binding

`stack/8042-v3-lossless-engine` depends on
`abfa0a4ad8c28df39b124594414064b5920d181d` (layer 2).
All files under `rust/diff/src` match full54 byte-for-byte. No native algorithm
is reimplemented. Native model keys, classes, hashes, components, containers,
aliases, class families, lineage and sidecar metadata use code-unit strings.
Options/results use lossless documents; scalar `options_from_json` remains for
native scalar callers. The obsolete `result_to_json` transport and all of its
callers are replaced together. `DiffModel` and the complete shared
`diff_transport.rs` also match full54 exactly, without changing JS signatures.
The general DTO reader retains the reference's 128-level bound; broader live
value semantics and operation-specific observers remain later parent work.

Native release plan: the `String` to `JsString` API change is intentional,
including `normalize_class` and public model fields. As checked on 2026-10-25,
the crates.io API reports that `ifc-lite-diff` does not exist, and the crate is
absent from the shared `CRATES` list used by release and semver checks in
`scripts/lib/crates-io.mjs`. Its first native publication must contain the
completed lossless API; there is no published scalar API baseline to retain.
The published npm WASM signatures remain unchanged, so their changeset is a
patch. This does not waive semver for any crate already in the release list.

The intentional binding adaptation is `diff_lineage.rs`, retained from v2:
staging scalar validation, typed serde field reads and exported ABI stay;
checked scalar values convert to native code-unit strings, outputs serialize
through the lossless document transport, and diagnostics convert back with a
checked scalar conversion. The guard is NOT removed. Existing actual WASM
lineage rejection, collision, accepted-scalar and invalid-share parity tests
remain unchanged from staging. Do not copy full54's lineage binding or its
replacement tests into this layer.

Native integration invariants remain split by dependencies: document invariants
in layer 1, fingerprint DTO/number invariants in layer 2, model/options/result
and native lineage invariants here. This preserves full54's native invariants
without duplicating its monolithic model test file in a later parent layer.

Parent qualification on this exact commit: native workspace tests and strict
`cargo clippy --workspace --all-targets -- -D warnings`; root pnpm typecheck/test
through turbo with built sibling dependencies; actual WASM raw model/options/
result code-unit parity and reference/row/order restoration, plus the retained
lineage scalar rejection and invalid-share tests. Full facade tests requiring
operation-specific observers belong to the later cutover, not these layers.

## Generator and validation handoff

The parent owns every heavy command. No runtime, declarations or parity vectors
were regenerated here. On EACH exact layer commit, use the registered fleet
launcher and storage task lifecycle for native tests/Clippy and
`scripts/build-wasm.sh` (the existing generator builds independent
`rust/diff-wasm` into `packages/wasm/pkg-diff` and strips platform trampolines).
Review generated `packages/wasm/pkg-diff/ifc-lite-diff.d.ts`, as well as the
main/retained declarations touched by the canonical generator, against the
known staging declarations. Keep any actual generated changes on their owning
layer; never hand-edit declarations to anticipate output.

For layer 1 exercise document serde and existing raw JSON WASM tests. For layer
2 additionally exercise `packages/wasm/test/diff-parity.test.mjs`'s positive
fingerprint boundaries/order/identity/Map/one-read/ignored-extra tests and
`rust/diff/tests/fingerprint_utf16.rs`. For layer 3 additionally exercise
`rust/diff/tests/model_utf16.rs`, native engine/lineage/transport suites, raw
WASM DiffModel options/results and `packages/wasm/test/diff-lineage-parity.test.mjs`.
All existing test scripts must run through root pnpm/turbo; missing payload
skips are incomplete coverage. Declarations are intentionally known-base until
this generation, so there is no claim of independently verified bindings.

No TS API surface or sandbox schema changed, so API-surface/bim-globals/docs
table generators have no new input here. Existing vector corpora are copied,
not repinned. Later observer/facade/oracle relocation, initialization and
performance qualification remain the parent's responsibility.

Application conflicts were limited to v2 fingerprint wiring and its README:
resolved by taking full54's typed decoder/caller and writing documentation for
these staged boundaries. No unresolved source conflict remains. Intermediate
layer compilation, strict Clippy, actual WASM execution, declaration generation
and performance qualification are PENDING, not passed.

## Source inspection receipt

Layer ancestry: staging `5408a0c4` -> document
`430374fa3fddf8e49928f939efe6d57ffef89351` -> fingerprint
`abfa0a4ad8c28df39b124594414064b5920d181d` -> engine ref named above.
Rust additions plus deletions per layer: 361 / 477 / 458. The document
foundation is slightly below the approximate 400-line target rather than moving
fingerprint-dependent code into it solely to reach a count.

Engine `rust/diff/src` tree object:
`71094c7b88cacf5dbe56ac0546bd9a4a43e3315f`, exactly equal to full54.
Fingerprint decoder/caller are identical to full54 at layer 2; raw model and
complete shared host transport are identical at layer 3. Each layer passes
`git diff --check`. Scoped source comparisons confirm every layer preserves all
tracked declarations, Cargo manifests/lock, toolchain config, all production
TS/JS, raw JSON bridge and pre-fingerprint test prefix, and lineage guard/tests
from the preparation base. These are source facts, not compilation/test results.

## Main #8081 restack

The merged main base supersedes the historical staging hashes above. Preserve
`diff_input.rs` and the raw constructor/options rejection and once-getter
regressions in layers 1–2. Layer 3 replaces both decoding call sites with
lossless transport, removes that staging module/file, and replaces rejection
assertions with actual WASM/TypeScript parity. Column and lineage guards retain
their separate later removal boundaries. No build or test was run in this restack.

At layer 3 the merged comparison staging guard is removed completely. Positive
raw constructor/options tests cover every dictionary slot and consumed option
path, lone units versus U+FFFD/literal escapes, the confirmed deletion, and
once-only getters. The public TS oracle is retained until public cutover.
`compareWithWasm` options are lossless here; its column guard remains until
the runtime adapter layer. `rust/diff-wasm/README.md` describes this boundary.
