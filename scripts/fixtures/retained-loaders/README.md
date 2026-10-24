# Retained loader syntax fixtures (#7955 R1–R3)

These small text inputs model the real loader's locator-bearing syntax, without
WASM/SDK binaries. Nothing in them is executed. The wasm-bindgen fixture includes
its in-memory `"./ifc-lite_bg.js"` import namespace and actual `__wbg_init` shape;
there is deliberately no `ifc-lite_bg.js` file. The Emscripten text fixture keeps
4.0.15 loader helpers, variable flows and optional filesystem loader definitions.
It omits unrelated engine glue and numeric/mangled exports. Emscripten portions
retain their MIT notice and the full corresponding licence is in
`../retained-notices/LICENSE`; they are test data, not a vendored SDK/toolchain.
The source observations were historical generator-format evidence, not current
build qualification.

`retained-loader-profiles.json` is a reviewed syntax contract. Its SHA256s are
computed over normalized AST structures, not source strings or compiled bytes.
The parser is the existing root TypeScript dependency, lockfile version 6.0.3.
Comments and formatting do not affect the structures. Each generated projection
includes every asset sink/entry-point reference and every reference, binding and
write of its named locator variables. Whole helper bodies bind variable
parameters to recognized call sites; `Module`/`createWasm` retain only locator
statements so unrelated mangled WASM export names do not change the contract.
The canonical client's entire AST binds its constructor's literal worker root
to its `this.workerUrl` Worker call. The driver helper is checked structurally,
with all call sites required to pass literals. Ordinary const-backed literal
URL chains are resolved separately, with ambiguous/reassigned bindings refused.

The positive default roots are `ifc-lite_bg.wasm`,
`ifclite_smlib_browser.wasm`, and `./worker.mjs`. All must exist in the staged
asset inventory. Supported wasm-bindgen `module_or_path`, Emscripten
`Module.locateFile` overrides and optional filesystem callbacks are caller
capabilities; this contract inventories the canonical default path, not arbitrary
future caller-supplied data files. Their known generator forms are preserved,
not relabeled as proof of a universal closed-world runtime.

A change to a profile, parser or a generator's locator shape requires inspection
of fresh source, review of the literal roots and call graph, positive/negative
fixture checks, and parent-owned real build/browser validation. There is no
command that automatically learns or approves a new profile from supplied code.
Tests mutate actual fixture inputs and assert dependency results/refusals;
source-text presence is never the asserted behavior. Unknown syntax fails closed
when it reaches the supported asset entry points. This is not an arbitrary-code
sandbox, an attestation of opaque binaries, or licence clearance.
