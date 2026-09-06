# Y-up orientation correction (#4056 / #4058)

This is functional evidence, not a throughput measurement or a production deployment check.

The directly built final WASM SHA-256 is `3291120b10dcbfa208db6c97574e2d247cdd4b9a28dde3fc1449313d68059b3c`.
Tested worktree source `9fbc153ead980bf7715cce2a6e9021fb1f803721` is byte-identical in Rust, packages, viewer sources and boundary contracts to publication source `371e3ce2c`.
The viewer was built through root Turbo with no cache hits. The browser runner verified every frozen asset and the embedded runtime before its six cases.

## Ground truth and checks

- The committed generated IFC4 triangle contract runs real flat and partitioned WASM extraction, the canonical shard decoder and real Scene materialization. Historical flat output fails the outward-normal invariant; corrected output passes.
- The actual-WASM demesher regression fails on the initial flat-only correction at IFC-local index order and passes on the complete correction. Native tests also exercise actual clustering and box replacement on a dense shell.
- Final WASM contracts: 83 passed, no failures, 3 fixture-dependent skips.
- Focused simplifier tests: 9 passed. Export library: 406 passed. Strict workspace/all-target Clippy passed.
- Root Turbo typecheck and viewer tests passed before the review follow-up: 7,009 viewer tests passed, 5 skipped. Follow-up changes affect Rust conversions and generated documentation; final CI separately validates the complete head.
- The adjacent browser JSON records six first-attempt final-artifact checks across Chrome and Firefox. Both browsers prove a real old cache hit, corrected cache miss and regeneration, corrected cache hit, and working federation/search/picking. Fresh Haus and large MEP loads check complete feature readiness.

## Limits

Flat triangle indices intentionally change. The migration witness compares every retained flat mesh: position and normal bytes remain unchanged, all triangle indices reverse, and raw/cache bytes match within each version. It does not claim universal correctness of authored normals, IFNS template byte identity or geometry closure. Canonical hashes alone do not certify downstream conversion. Existing exported geometry must be regenerated to receive corrected indices.

The public binary cache layout and native canonical producer are unchanged. A viewer geometry-output revision makes old geometry keys miss; it does not rewrite external prepared exports. No performance percentage is claimed by this correction.
