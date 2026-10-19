# Imported numeric program

This crate consumes source-independent, already-composed USD tessellation and
point coordinates. It does not parse IFCX, STEP or USD, assign product IDs,
or decode external assets. `graph::GraphProgram` owns iterative graph traversal,
inheritance/visibility eligibility, the emitted-key set, ordered mesh/point passes
and sequenced source requests. The host supplies composed graph facts, encodes the
historical dedup key and performs the established attribute/image/point codecs. `ImportedDefinition`
owns original f64 numeric arrays and the root-to-leaf raw matrix stack.
`scene::ImportedGeometryProgram` admits occurrences, issues Ready operations,
checks completion identity and kind, and retains source alongside assembled output.
The format adapter remains the authority for composition, metadata and codecs.

The same `process_packet` executes in native geometry, the canonical full WASM
`processImportedGeometryPacket` binding, and the small generated artifact used by
`packages/ifcx/src/imported-kernel.ts`. Its default runtime is static ESM generated
by Binaryen from that WASM, so synchronous extraction requires neither WebAssembly
nor runtime code generation. There is no independently maintained JavaScript math
implementation. A separate generated WASM byte module supports parity checks.

## Rebuild

Use the repository's pinned Rust nightly and `wasm32-unknown-unknown` target.
Binaryen must match the recorded binary exactly. The initial Linux x86_64 tool
comes from emsdk **4.0.15**, emsdk repository revision
`3b3963d86a5c97adaf6eaa845cdfe0b811c2f960`:

```sh
git clone https://github.com/emscripten-core/emsdk.git /your/tool-cache/emsdk
git -C /your/tool-cache/emsdk checkout 3b3963d86a5c97adaf6eaa845cdfe0b811c2f960
/your/tool-cache/emsdk/emsdk install 4.0.15
export IFC_IMPORTED_WASM2JS=/your/tool-cache/emsdk/upstream/bin/wasm2js
```

Expected version: `wasm2js version 124 (version_124-26-gcf756c929)`.
Expected executable SHA-256:
`fb4bc51da37e8ea8917552fdcb6edf8e1b77e9081c220579b78c50c429b29f2a`.
The generator refuses a different executable; qualifying another platform/tool
requires an explicit pin update and output comparison. The environment variable
is required outside the original provisioned host's discovery path.

Run `pnpm build:imported-geometry` through `ifc-fleet run --cwd CHECKOUT -- ...`
and the machine's project environment wrapper. Never nest admission. The generator
records Rust compiler, command, lockfile, generator/source digests, translator
version/checksum and both artifact digests. The small artifact disables SIMD for wasm2js and uses
a 1 MiB stack; the full canonical WASM keeps its own build settings.
Commit all generated files together.
Ordinary root Turbo builds run `--verify` and copy the static ESM into package
dist without invoking Rust or Binaryen. Install and typecheck remain Rust-free.

## ABI v1

All integers and floats are little-endian. Inputs begin with u32 version (1),
u32 operation. Numeric vectors encode u32 length plus f64 elements; matrices
encode vectors of rows; stacks encode vectors of matrices. Mesh/point operations
carry four u64 values: store, revision, definition and occurrence. Output begins
with u32 total byte length, u32 status (0 success, 1 error); errors contain UTF-8.
Typed f32 output preserves nonfinite values and signed zero. Operation numbers:
1 transform stage, 2 mesh, 3 points, 4 f32 stage (UV/colors), 5 normal matrix,
6 computed normals. Operations 100–107 control the owned graph registry and its
requests, replies and output acknowledgements. `packet.rs`, `graph_packet.rs` and
the TS adapters are the precise field order. Graph handles are explicitly closed
by their host owner, including errors; no request borrow crosses a host callback.

The raw C exports allocate/free exact byte slices and execute one complete packet.
Every host allocation is freed in a finally block after output is copied. A
caller must never pass foreign pointers or incorrect allocation lengths.
