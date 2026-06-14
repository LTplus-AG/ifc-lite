---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Fix WASM geometry stall on opening-dense walls (follow-up to #1097).

Walls carrying many openings (e.g. a curtain/window wall with 8-14 voids) stalled
the streaming geometry load in WASM — one such element could block a worker for
40-150 s, tripping the stream watchdog. Native processing of the same element was
~0.2 s; the gap is WASM's emulation of the exact kernel's wide-integer (i1024)
predicates, amplified by two structural costs that this change removes:

- **Opening-dense host refinement.** A window wall is usually two huge face
  triangles per side, so every void's intersection segments pile onto those few
  triangles. The exact arrangement then re-triangulates a single triangle carrying
  dozens of constraint segments (O(k²)), and — worse — the batched N-ary subtract
  leaves unrecovered constraints and degrades to the O(N²) sequential path
  (re-arranging the growing host once per opening). When a host has ≥ 8 openings we
  now pre-subdivide it (1-2 levels of uniform midpoint subdivision) so each
  triangle carries only a few segments and the batched cut recovers. `consolidate_
  coplanar` re-triangulates each coplanar group afterwards, so the temporary
  interior vertices don't survive except where a hole boundary pins them.
- **Conservative broadphase prefilters in the exact re-triangulation.** The three
  O(N²) exact-predicate scans (`insert_point` point-location, `enforce_constraint`'s
  collinear-vertex scan, `recover_subsegment`'s channel scan) now skip the exact
  test for vertices/triangles outside a generously-widened f64 AABB, and all-explicit
  `orient2d` triples use the fast adaptive Shewchuk predicate instead of the
  WASM-emulated i1024 lambda path. The margin dwarfs any f64/implicit-point error,
  so the exact predicate still decides every retained case — output is byte-identical
  on every platform.

Net: the worst dense wall drops from ~150 s to ~30 s in WASM (10× on most), the
model loads without stalling, and native cold-load is ~20 % faster overall. The
refinement is gated to ≥ 8-opening hosts (absent from the snapshot fixtures), so
the determinism corpus and committed snapshots are unchanged; the prefilters and
Shewchuk path are byte-identical everywhere. Geometry suite 439/439 green.
