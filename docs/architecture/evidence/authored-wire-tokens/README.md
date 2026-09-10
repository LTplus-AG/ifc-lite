# Authored wire-token refusal (#4441)

`authored-wire-wasm.test.ts` exercises the rebuilt native annotation and captured
creators through real StoreEditor rows, StepExporter and parser reopen. Both
creators refuse reserved structural Names and image URIs before returning a
plan. Six ordinary/near-token Names per creator retain their exact decoded
text, including apostrophes, Unicode and U+0085 surrounding a reference-like
substring. ECMAScript trims U+FEFF but not U+0085; the native guard matches that
boundary. This is explicit refusal of previously misserialized input, not an
unqualified literal-string extension to the mutation wire protocol.

Validation at `aad7def981713dd299bf2d3db152f9a2b8f1fe2a`: root build and typecheck
passed; actual host roundtrip had no skips; native workspace passed (3,025 tests,
37 ignored); strict workspace/all-target clippy passed. Four final issue
regressions include source material-name preservation. Existing actual-WASM
contracts passed with only their three pre-existing optional fixture skips.
A freshly rebuilt and independently installed PyO3 wheel matched all four
committed IFC quick-lane references, retaining the existing halfspace triangle
density advisory. No geometry algorithm or public API changed.

`native-load.json` records source-matched, interleaved five-iteration native
normal-load probes on the public AC20 fixture, with all other agents explicitly
idle. Fingerprints were collected separately. Normal-load total and geometry
best-of-five values matched, with a quantized parse-only variation in the first
pair. All mesh counts and fingerprints matched. This supports no detected
normal-load regression in this bounded probe; it does not measure authoring
throughput or establish a worker-pool speedup.
