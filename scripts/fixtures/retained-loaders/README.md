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
with all call sites required to pass literals. Ordinary const-backed primitive
string chains are resolved separately. Every declared binding is counted, including
nested/renamed/rest object and array patterns, parameters, catch/loop variables,
imports, and function/class names. Only a uniquely named simple `const` declared
in a module or block can supply an initializer. Its lexical block must contain
the reference, and its declaration must textually precede it. The same checks
apply recursively at each initializer's own use site. Pattern values, mutable
variables, loop/switch declarations, writes, and repeated names (even in disjoint
scopes) are conservatively refused when needed to resolve a locator. Unrelated
patterns are allowed; property keys are not mistaken for declared variable names.
This is a proven limited subset, not general lexical or control-flow inference.

Static exports/imports, dynamic imports, and the driver helper's module requests
share the same prefix check: `./`, `../` or a supported absolute path is required.
Bare `runtime.mjs`, `.runtime.mjs` and `..runtime.mjs` are not sibling imports;
there is no import map. Fetch/Worker/importScripts paths do not resolve like
module imports: a raw relative string has an unknown execution-context base and
is refused. `/smlib/` origin-root strings remain supported under the existing
same-origin hosting contract. Fresh `new URL(path, import.meta.url)` expressions
carry explicit module-base provenance. They may be consumed directly by a known
asset sink, or immediately converted to a primitive with `.href`; that immutable
string preserves its base through the supported const chains.

URL objects in ordinary bindings, aliases, container properties, opaque calls
or returns are refused, including a seemingly unmodified `const url = new URL`
flow. A const binding does not make the object's properties immutable. Neither
`url.href` on a stored object nor an unknown helper converting the object is a
proven primitive extraction. This bounded subset avoids attempting whole-program
escape/mutation analysis. It does not replace the separately reviewed canonical
and generated variable-based loader profiles, which remain byte-for-byte intact.
The generated Emscripten Node-only `module`/`node:module` dynamic import exception
requires the matching reviewed profile, not merely a matching filename.

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

Parent-review R3-F1/F2 regressions use distinct document, worker and module bases
and keep both plausible local asset locations present. Record/stage must refuse
unknown context-relative strings and mutable URL object flows without publishing.
The prior 63-case coverage is retained, with four positive controls corrected:
two now extract/use primitive href values or fresh explicit module URLs, the
renamed-binding control supplies explicit module bases, and the raw fetch-path
control now asserts refusal plus a valid origin-root control. The shared synthetic
engine fixture exports a primitive href instead of an unsupported stored URL
object. The real generated-loader fixtures and syntax profile pins are unchanged.
These changes correct fixture assumptions; no negative case is removed or skipped.
