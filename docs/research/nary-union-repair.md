# Preserving cutter geometry during N-ary union repair

Issue #3925 separates two contracts that the near-coplanar weld had combined.
A union used as a cutter without an over-cut bound must preserve the supplied
solid. Moving vertices to reconcile nearby planes is an approximation even
when the resulting boundary is closed. On the real thin-covering fixture,
that approximation changed the amount of material removed.

The shared-vertex guard also belongs to the N-ary mutual weld, not ordinary
subtraction. Freezing only a cutter face’s exactly shared corners while its
other corners are reconciled changes that face. The subtraction path retains
its original whole-face reconciliation behavior.

## Published work informing the change

- [CGAL’s corefinement documentation](https://doc.cgal.org/5.6.1/Polygon_mesh_processing/index.html#coref_def_subsec)
  distinguishes exact topological decisions from rounded output coordinates.
  Valid exact intermediate geometry does not establish validity after rounding.
- [CGAL’s autorefinement and snap-rounding implementation](https://www.cgal.org/2025/06/13/autorefine-and-snap/)
  performs defect-driven repair with bounded repetition. It does not guarantee
  termination to a valid result for every input.
- [Zhou et al., Mesh Arrangements for Solid Geometry](https://www.cs.columbia.edu/cg/mesh-arrangements/)
  supports retaining a shared variadic arrangement and explicit cell labels,
  rather than repeatedly perturbing a growing pairwise accumulator.
- [Cherchi et al., Interactive and Robust Mesh Booleans](https://arxiv.org/abs/2205.14151)
  describes exact intersection constraints and connected-patch classification.
  Its robustness depends on input preconditions; it is not a guarantee for
  arbitrary damaged IFC triangle soup.

These sources motivate the design; they do not prove the implementation or its
performance. The fixture tests, census, mutation checks and end-to-end probes
supply that evidence.

## Implemented boundary

The original N-ary arrangement runs first. If its emitted, consolidated mesh
passes the existing N-ary directed-edge incidence check, it is returned
unchanged. Otherwise one mutual-weld candidate is attempted. A rejected or
incomplete candidate leaves the completed original arrangement in place. Both
attempts remain charged to the existing predicate budgets; no retry loop or
counter reset is introduced.

The audit uses the existing N-ary test convention: a `1e-4` **caller-unit**
position grid, with exactly one forward and one reverse incidence per edge.
It rejects collapsed edges and doubled sheets. This is a resolution-specific
topology check, not proof of exact f32 closure, absence of self-intersections,
volume preservation, or correct cutter extent. Consolidation is evaluated on
a copy so the original returned representation stays intact.

The 3D opening-union consumer uses the same shared arrangement without
coordinate-moving repair. That preserves the premise behind its unbounded
volume acceptance. The bounded prism and roof-chain consumers retain their
existing downstream acceptance rules. The roof-chain path first subtracts the
original union; a rejected or diagnostically torn subtraction permits one
reconciled candidate. That candidate must pass the same subtraction acceptance
and bounds checks without failure diagnostics. Its removed volume must not
exceed the sum of the individual trial removals. A diagnostically invalid or
numerically unusable trial disables this coordinate-moving repair: it cannot
certify a removal bound. Overlap makes the sum an upper bound, not proof of the
exact intended volume. An unsuccessful repair retains
the original result and its diagnostics, or the existing sequential fallback
when there was no acceptable original. Both native and WASM use
these same Rust entry points.

The real-file census golden is unchanged. Separate controls retain the
segmented-roof fix and the N-ary near-coplanar sweep. The existing accept-gate
fallback repair in #3922 is a dependency, not a replacement for these checks.

## Follow-up boundaries

Exact-coordinate retention through longer boolean chains, local defect-driven
corefinement, and geometric T-junction audits may improve this further. Each
needs its own correctness and memory/performance evidence. This change does
not replace the pure-Rust kernel, widen plane tolerances, or claim that fewer
open edges alone establish a correct solid.
