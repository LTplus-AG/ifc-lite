# Plato single-source codegen spike

Companion artifacts for `docs/research/plato-single-source-codegen.md`: can the
[Plato language](https://github.com/cdiggins/plato) act as a single source for
math that ifc-lite currently hand-mirrors between Rust and TypeScript?

Everything here was generated and verified offline with Plato.CLI. The
generated files (`plato.rs`, `plato.g.ts`) are committed so the spike is
inspectable and runnable without the Plato toolchain.

## Layout

```
bounds/   level 0: minimal AABB library, bit-exact dual-target parity proof
  plato-src/ifc_bounds.plato   the single source (60 lines)
  plato-src/geometry.plato     primitive scaffolding (from cdiggins/plato, MIT)
  rust/                        parity harness crate (prints f64 bit patterns)
  ts/                          identical TS harness
clash/    level 1: real target, the mirrored clash math kernel
  plato-src/clash_math.plato   single-source port of vec3 + aabb + SAT tri-tri
  plato-src/scaffold.plato     trimmed primitive scaffolding
  generated/plato.rs           Rust output (344 lines, passes cargo check)
  generated/plato.g.ts         TypeScript output (319 lines, passes tsc)
  validation/rust/             adapter + golden tests (11, from rust/clash tests.rs)
                               + 20k-case differential fuzz + release bench
  validation/ts/               adapter + the real triangle.test.ts suite
                               + 340k-comparison differential fuzz + bench
```

Validation harnesses carry their own copy of the generated file and of the
hand-written originals they diff against, so they run self-contained:

```sh
cd tools/plato-spike/clash/validation/rust && cargo test
```

The clash source ports the semantics of
`packages/clash/src/math/{vec3,aabb,triangle-intersect}.ts` and
`rust/clash/src/{vec3,aabb,triangle}.rs`. Fold helpers mirror the imperative
accumulator updates exactly so NaN handling matches by construction.

## Running the bounds parity proof

Rust side:

```sh
cd tools/plato-spike/bounds/rust
cargo run --quiet > /tmp/parity-rust.txt
```

TypeScript side (from repo root; emits CommonJS because the repo is ESM):

```sh
cd tools/plato-spike/bounds
../../../node_modules/.bin/tsc --ignoreConfig --target es2022 --module commonjs \
  --outDir ts/js ts/plato.g.ts ts/harness.ts
echo '{"type":"commonjs"}' > ts/js/package.json
node ts/js/harness.js > /tmp/parity-ts.txt
diff /tmp/parity-rust.txt /tmp/parity-ts.txt && echo PARITY
```

The outputs are f64 bit patterns and must be byte-identical.

## Regenerating from .plato source

Requires a .NET 9 SDK and a one-time sibling layout (Plato.CLI references
`ara3d-sdk` two directories above its repo root):

```sh
mkdir plato-workspace && cd plato-workspace
git clone https://github.com/ara3d/ara3d-sdk.git
mkdir nest && cd nest
git clone --recurse-submodules https://github.com/cdiggins/plato.git
dotnet build plato/Plato.CLI -c Release
```

Then, for either spike directory:

```sh
dotnet plato/Plato.CLI/bin/Release/net9.0/Plato.CLI.dll <plato-src-dir> <out-dir> --typescript
dotnet plato/Plato.CLI/bin/Release/net9.0/Plato.CLI.dll <plato-src-dir> <out-dir> --rust
```

Caveats (details in the research doc): the CLI exits 0 even on compile failure,
so check the output file; the generated header contains a timestamp that must
be stripped before any byte-diff freshness gate.
