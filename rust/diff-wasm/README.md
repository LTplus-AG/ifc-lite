# Lossless model bindings (#8042, #8081)

The raw `DiffModel` constructor dictionary and comparison options now use
`diff_transport` and native code-unit strings/documents. Lone UTF-16 units,
literal U+FFFD, paired surrogates and literal backslash escapes remain distinct.
The temporary scalar rejection module `diff_input.rs` and both of its call
sites were removed together at lossless engine layer 3. No fallback or new
public export was added.

Actual-WASM regressions in `packages/wasm/test/diff-parity.test.mjs` compare
all constructor dictionary slots and consumed string option paths with the
TypeScript engine, retain the confirmed exclusion/deletion case, and count
option and nested getters once. Raw options use the final transport's pair
arrays (`losslessInput` in the tests converts public ReadonlyMap aliases).
These tests require the fresh independent WASM payload and root-built TS
oracle; missing prerequisites are explicit skips, never qualification.

The public TypeScript engine remains in place through the lower layers.
The host observer layer replaced the separate lineage scalar guard. The
runtime adapter layer now removes the JS column scalar guard and extends the
positive parity tests to lossless rows through `compareWithWasm` too.
Raw JSON syntax validation is retained throughout. Fingerprint typed transport
became lossless at layer 2. Later public cutover relocates the TS oracle privately.

This is local source preparation only. The parent owns exact-head native tests,
strict workspace Clippy, generated declarations and root pnpm/Turbo actual-WASM
qualification before any push. No tests or builds were run during this restack.
