# Error Handling and Integration Contract

This page is the behavioral contract for integrating ifc-lite into another
system: what you get when things fail, how to manage memory across the WASM
boundary, what is guaranteed to be reproducible, and what stability to expect
across versions. It complements the per-feature guides, which cover the happy
path.

## Parse and geometry errors

The Rust crates return typed `Result`s (a `thiserror` `Error` enum with variants
such as `ParseError`, `InvalidEntityRef`, `InvalidIfcType`). Failures propagate
as `Err`, not panics.

The STEP parser degrades safely on malformed input. It rejects a bad record with
an `Err`, skips unparseable bytes and continues scanning to the next valid
entity, and never panics, hangs, or overflows the stack on hostile bytes. This
is covered by malformed-input regression tests and a coverage-guided fuzz target
(`rust/core/fuzz/`); see the testing guide for how to run the fuzzer.

At the WASM boundary, a hard failure surfaces as a thrown JavaScript error. Wrap
calls that ingest untrusted files in `try/catch`.

## The WASM cache is fail-fast (long-lived workers and servers)

`IfcAPI` keeps per-load caches (entity index, parts-to-skip, material-layer
index) behind mutexes that **fail fast**: if an earlier call panicked while
holding a lock, the lock is poisoned and the next call panics rather than
operating on inconsistent cache state. In a long-lived worker or a multi-tenant
server, one malformed file can therefore leave that specific `IfcAPI` instance
unusable.

The recovery contract is simple: **on any thrown error, discard that `IfcAPI`
instance and create a fresh one.** Do not keep using an instance that has thrown.

```ts
let api = new IfcAPI();
try {
  const result = api.processGeometryBatch(/* ... */);
  // ... use result ...
} catch (err) {
  // The instance may be poisoned; do not reuse it.
  api.free();
  api = new IfcAPI();
  throw err; // or handle and continue with the fresh instance
}
```

## Memory management (WASM)

Memory is managed manually across the WASM boundary. Every handle, mesh,
collection, and the `IfcAPI` itself implements `free()` and `[Symbol.dispose]()`.
Call `free()` (or use a `using` declaration) to release Rust-side memory,
**including on error paths**, since a thrown call can still leave allocated
objects.

```ts
function withMeshes(collection: MeshCollection) {
  try {
    for (let i = 0; i < collection.length; i++) {
      const mesh = collection.get(i);
      try {
        upload(mesh);
      } finally {
        mesh.free();
      }
    }
  } finally {
    collection.free();
  }
}
```

Most consumers should not manage this by hand: use
[`@ifc-lite/geometry`](geometry.md)'s `GeometryProcessor`, which wraps the
pre-pass and job-batch flow and frees handles for you.

## Determinism scope

For a critical system that checksums or compares geometry, know exactly what is
reproducible:

- **The exact-arithmetic predicate / CSG kernel is byte-identical across
  `x86_64`, `aarch64`, and `wasm32`.** Predicate signs are integer parity over
  FMA-free IEEE-754 arithmetic (the kernel uses no fused multiply-add), pinned by
  a cross-platform sign manifest. A scheduled workflow re-runs the predicate
  battery and a mesh-stat parity check on arm64 against committed x86_64
  snapshots, so a platform-dependent regression fails the build.
- **Everything else is run-deterministic, not cross-platform-guaranteed.**
  Tessellation density, styling and colour-map iteration order, and rounding in
  non-exact paths can differ between architectures. If you store a geometry
  checksum as a baseline, compute it on the same architecture you will compare
  against.

## Versioning and stability

Packages (`@ifc-lite/*`) and the Rust crates are versioned with
[changesets](https://github.com/changesets/changesets); a breaking change bumps
the major version. Pin a version for reproducible builds.

One caveat for integrators: the mesh and exported-data formats are **not yet
semver-guaranteed to be byte-stable across minor versions**. If you persist
serialized geometry or exports, re-validate them when you upgrade, rather than
assuming the bytes are identical.
