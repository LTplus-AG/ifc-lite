# Plato as a single source for Rust/TS mirrored math

Status: shipped as a contained pilot on the clash math kernel (this branch).
The exploratory spike artifacts (bounds parity demo, standalone validation
harnesses) live on branch `spike/plato-investigation` under `tools/plato-spike/`.
Dates: spike 2026-07-09, production integration 2026-07-10.

## What Plato is

[Plato](https://github.com/cdiggins/plato) (MIT, Christopher Diggins / Ara 3D) is a
small, pure, statically typed language for writing geometric and numeric libraries
once and compiling them to idiomatic code on several targets. Three constructs:
`type` (pure data), `interface` (type classes), `library` (free functions with
dot-call syntax). No mutation, no exceptions, no strings worth speaking of; f64
numerics. The C# backend is production quality (it feeds the Ara 3D SDK). The
TypeScript and Rust backends are working proofs of concept: they compile a curated
252-line demo subset (`demos/plato-src/geometry.plato`), not the full 3,500-line
standard library (compiling the full stdlib to Rust today yields 1,724 errors).

## Why it maps onto ifc-lite

ifc-lite has exactly one hand-mirrored numeric kernel: the clash math.

- `packages/clash/src/math/{vec3,aabb,triangle-intersect,triangle-distance}.ts`
  (~420 lines) and `rust/clash/src/{vec3,aabb,triangle}.rs` (~460 lines) are
  declared faithful ports of each other, down to the comment in
  `rust/clash/src/tri_mesh.rs` requiring operators to "match the TS kernel's
  operators EXACTLY, including NaN handling".
- The mirror discipline is enforced today only by twin test suites and review
  care. We found one latent divergence while porting: TS `signedGap` uses
  `Math.max` (NaN-propagating), Rust uses `f64::max` (NaN-ignoring). Harmless
  for finite inputs, but it is precisely the class of drift a single source
  eliminates by construction.

Beyond clash math, the duplication map is thinner than expected for Plato
specifically: the other big mirrors (geometry diagnostics wire shape, georef
label and unit-scale inference, project units) are string- and serde-shaped,
which Plato cannot express at all. Those stay with the existing
`packages/codegen` + shared-fixture-pin approach (`unit_symbol_vectors.json`
pattern). Plato addresses only the pure-numeric slice.

## What the spike proved

Spike artifacts live on branch `spike/plato-investigation` under
`tools/plato-spike/`, runnable offline; commands in its README.

Level 0, `bounds/`: a 60-line `ifc_bounds.plato` (AABB include/union/contains/
intersects, MeshData.origin folding, symmetric clip pad) compiled to both
targets. Identical harness programs (shared mulberry32 PRNG, 256 points) print
f64 results as raw bit patterns: Rust and TypeScript output is byte-identical
across all 14 checked values, including empty/contains/intersects predicates.

Level 1, `clash/`: a 230-line `clash_math.plato` porting the real mirrored
kernel semantics: all of vec3, the AABB algebra (inflate, center, intersects,
contains, signedGap, overlapBounds, boundsOfPoints), and the SAT
triangle-triangle intersection with the exact eps-skip and touch-as-separation
comparisons. Because Plato has no local bindings, accumulator loops become fold
helpers shaped exactly like the imperative updates (`FoldMin(acc, p) = p < acc ?
p : acc`), which reproduces the NaN behaviour of the originals by construction;
infinity is spelled `(1.0 / 0.0)` so both backends produce +inf at runtime with
no target-specific literals. Generated output is 344 lines of Rust and 319 lines
of TypeScript; both compile clean (cargo check, tsc).

Validation (see "Validation results" below): the generated TS was wired behind
tuple adapters into the real `packages/clash/src/math/triangle.test.ts` suite,
and the generated Rust against the golden scenarios from
`rust/clash/src/tests.rs`, plus 20k-case differential fuzzing against the
hand-written originals on each side, bit-exact comparisons.

## Generated code reality

Readable but non-idiomatic, on both targets:

- PascalCase methods everywhere; the Rust writer emits no `std::ops` or trait
  impls (`a.Add(b)`, never `a + b`) and a blanket `#![allow(clippy::all)]`.
- `&&` and `||` compile to eager `.And()/.Or()` calls: no short-circuiting.
  Irrelevant for pure math, fatal for anything with side effects or guards.
- TS emits one class per type; every vector op allocates. Fine for the
  wasm-fallback clash path, not for hot per-frame renderer code.
- The `// Created on <timestamp>` header must be stripped for byte-stable
  freshness gates (same class of fix as the wasm-pack index stripping in
  `scripts/build-wasm.sh`).
- Plato.CLI exits 0 even when parsing or compilation fails; wrappers must
  verify the output file exists, is non-trivial, and compiles.
- No type checker yet: errors surface from rustc/tsc against generated code,
  not from `.plato` source lines. Manageable at a few hundred source lines.

## Toolchain reality

Plato.CLI does not build from a bare clone: it needs .NET 9, the vendored
`parakeet` submodule, and an `ara3d-sdk` checkout as a sibling of the repo's
parent (for `Ara3D.Logging`/`Ara3D.Utils`). Any adoption means pinning both
repos at SHAs and reconstructing that layout in a generation script. Per repo
policy (committed generated outputs, consumers never need the generator
toolchain), generation would be an offline script plus one path-filtered CI
freshness job; never part of `turbo build`, dev bootstrap, or Vercel. Precedent
already in-repo: `packages/codegen` (EXPRESS to .rs + .ts), the committed
`packages/wasm/pkg/ifc-lite.d.ts` with its regenerate-and-diff CI step, and
`scripts/generate-epsg-index.ts`. `/generated/` paths are already exempt from
the module-size ratchet.

Risk that dominates everything else: bus factor of one. Single maintainer,
verification gates live in a private-layout monorepo, no CI in the plato repo
itself. Treat any adoption as vendoring a frozen tool at a pinned SHA. The exit
path is real, though: the generated code is readable and committed, so ejecting
means stop regenerating and own the output as source.

## Options, ranked

1. Contained pilot on the clash math kernel (this spike, productionized):
   single `.plato` source for vec3/aabb/triangle-intersect, committed generated
   files behind the existing tuple-based public APIs as thin adapters, CI
   freshness gate cloned from the `ifc-lite.d.ts` pattern. Deletes ~880 mirrored
   lines and retires the NaN-drift class. Effort: days, reversible.
2. Regardless of Plato: extend `packages/codegen` and shared parity fixtures to
   the string-shaped mirrors (diagnostics wire shape, georef label inference,
   unit extraction). Higher drift risk retired per hour than anything Plato can
   touch; Plato is structurally unable to help there.
3. If (1) lands and holds: policy that new dual-target pure math is authored in
   `.plato` first. Explicitly out of scope: hot renderer f32 paths, the exact
   arithmetic CSG kernel (no bignum/interval types in Plato), anything with
   strings.
4. Fallback: watch upstream for the native type checker and Rust backend
   maturation (operator traits, richer intrinsics); optionally upstream the
   deterministic-header fix we need anyway.

Rejected: adopting the Plato stdlib as reference algorithms (frozen, with a
known-failures list including wrong `MagnitudeSquared` scaling) and Plato as a
viewer scripting layer (no strings/IO; the viewer already has a scripting
surface).

## Validation results

TypeScript (generated code behind tuple adapters, harness in
`tools/plato-spike/clash/validation/ts/`):

- Real suite: `packages/clash/src/math/triangle.test.ts` run unmodified against
  the adapter (with `triangle-distance.ts` consuming Plato-backed vec3
  primitives): 6/6 pass.
- Differential fuzz vs the hand-written originals: 17 functions x 20,000 cases
  with injected degeneracies, 340,000 bit-exact comparisons, 0 non-NaN
  mismatches.
- NaN batch (report-only): `signedGap`, `overlapBounds` and `boundsOfPoints`
  diverge exactly as predicted (`Math.max` NaN-propagation vs ternary folds);
  `triTriIntersect` shows zero NaN divergence because the original already
  uses ternary-shaped accumulator updates.
- Perf: adapter about 2.2x slower overall (signedGap worst at 6.1x). This is
  allocation and marshalling overhead of the class-per-op codegen, not math.
  Tolerable for the wasm-fallback clash path; would need adapter-level
  flattening anywhere hot.

Rust (generated code behind `[f64;3]` adapters, harness in
`tools/plato-spike/clash/validation/rust/`):

- Golden scenarios ported from `rust/clash/src/tests.rs`: 11/11 agree with the
  hand-written reference bit-exactly (`f64::to_bits` per component).
- Differential fuzz: 20,000 cases, 0 non-NaN mismatches; the NaN batch
  diverges in the same three aabb functions (`f64::max` NaN-skipping vs
  ternary), as predicted.
- Perf: parity with the hand-written reference (total ratio ~0.91x to 1.05x;
  `tri_tri_intersect` ~1.05x). The Copy structs monomorphize to equivalent
  machine code, so the codegen shape costs nothing on the Rust side.

Both harnesses re-verified in place on the spike branch (cargo test: 13/13;
fuzz verdict PASS).

## Production integration (this branch)

- Single source: `tools/plato/clash_math.plato` (+ `scaffold.plato`).
- Committed generated outputs: `rust/clash/src/generated/plato.rs` and
  `packages/clash/src/math/generated/plato.g.ts`. `vec3`, `aabb` and
  `triangle-intersect` on both sides are now thin adapters with byte-compatible
  public APIs; the triangle distance routines stay hand-written twins (out of
  Plato's expressive range for now) but consume the Plato-backed vec3 ops.
- TS prototype pollution and dispatch overhead are gone: a deterministic AST
  codemod (`tools/plato/scalar-codemod.mjs`) rewrites scalar method calls to
  native operators and lifts the former Number/Boolean prototype helpers into a
  module-scoped namespace. The committed TS contains no `prototype` access and
  no `declare global`. The one ambiguous method name was removed at the source
  (`Vec3.Add` renamed to `Plus`), and the codemod fails loudly on any future
  class/scalar name collision.
- TS perf ends up ahead of the old hand-written code. Codemod phase 1
  removes prototype dispatch; phase 2 (flatten-codemod.mjs) symbolically
  inlines the pure method bodies into flat tuple-native kernels (beta
  reduction, scalar replacement of the Vec3/Box3 records, hash-consed
  common-subexpression hoisting), eliminating all per-call object allocation.
  The flattened SAT alone microbenches 4-5x faster than the old kernel (no
  per-call axis arrays); end to end, the default TS clash engine runs a dense
  2,744-element scene about 20 percent faster than main (406ms vs ~528ms,
  identical clash sets). The Rust engine is at parity (~1.0x).
- Generation is offline and reproducible: `node scripts/generate-plato-clash.mjs`
  clones plato, parakeet and ara3d-sdk at pinned SHAs, builds Plato.CLI with a
  .NET 9 SDK, verifies output non-trivially exists (the CLI exits 0 even on
  failure), strips the nondeterministic timestamp header, runs the codemod, and
  writes the committed files. Two back-to-back runs produce byte-identical
  output on both targets.
- CI freshness gate: a path-filtered `plato-check` job in test.yml regenerates
  with `--check` and fails on drift, wired into the required aggregate check,
  mirroring the committed-wasm-types pattern. Consumers never need dotnet.
- Cross-language behavior lock: `packages/clash/src/differential.test.ts`
  (WASM kernel === TS kernel) now compares two artifacts generated from the
  same source.

## Reproducing

Production regeneration: `tools/plato/README.md` (script, pins, traps). Spike
harnesses: `tools/plato-spike/README.md` on branch `spike/plato-investigation`.
