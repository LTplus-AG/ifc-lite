# Staged diff bindings (#8042, #8081)

The public TypeScript diff engine remains unchanged. These bindings and the
internal `compareWithWasm` adapter are under qualification; they do not yet
provide the final lossless facade.

`src/diff_input.rs` temporarily rejects unpaired UTF-16 code units before
serde-wasm-bindgen can replace them with U+FFFD. This covers every raw
`DiffModel` constructor dictionary string and the strings consumed from
`excludeTypes`, both `keyAliases` endpoints, and `classFamilies` names.
The error directs callers to the public TypeScript `diffModels` API. Literal
U+FFFD, paired surrogates/astral characters, and literal backslash escapes
remain accepted. Option getters are decoded once; this guard projects only
the fixed consumed paths rather than recursively prewalking arbitrary input.
Other options retain their existing serde_json conversion, including the
already known non-finite JSON limitations.

**Removal/restack requirement:** the lossless layer-3 transport must replace
both raw constructor and raw comparison string decoding in `src/diff.rs`.
When restacking that layer over this checkpoint, delete `src/diff_input.rs`
and its `mod diff_input` declaration in `src/lib.rs` in the same change after
replacing both call sites. Change the rejection regressions in
`packages/wasm/test/diff-parity.test.mjs` into lossless TS parity assertions
for raw exports and `compareWithWasm`, retaining the confirmed deletion case,
every string boundary, scalar distinctions, and getter-count coverage. Do not
leave the temporary guard orphaned or keep a rejecting fallback alongside
the lossless transport.

The added actual-WASM tests require a freshly built diff WASM bundle and the
root-built TypeScript oracle. Missing prerequisites are explicit skips, not
qualification. Runtime checks and
`cargo clippy --workspace --all-targets -- -D warnings` remain required before
pushing Rust changes.
