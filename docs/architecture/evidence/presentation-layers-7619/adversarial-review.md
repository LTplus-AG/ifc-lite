# Independent adversarial review — #7619

Final source reviewed: `e9d5c0cf28483e59ae21bc47b4d040ac16065e30`.
Base: `f1d7254b73`. Review date: 2026-10-15.

Verdict: no unresolved correctness blocker or known reproduced omission remains
from the finite supported-geometry audit. Required CI and the maintainer's merge
decision remain separate. Any subsequent production change requires delta review.
Earlier review receipts are preserved in Git history; this consolidates their
conclusions and the final metadata-readiness review.

## Scope and method

An independent reviewer read the agreed specification, complete production diff,
new parsed-STEP and mounted tests, relevant schema registries and native geometry
consumers, and existing selection, ID, mutation, reveal and annotation helpers.
The reviewer did not author production changes. Findings were sent directly to
implementers and repairs reread at their exact source revisions. The final source
delta passed `git diff --check`; documentation-only intervening commits were
separately verified. Heavy validation was coordinated with the lead agent.

## Correctness findings and final invariants

- Assignments remain distinct by model and assignment ID; duplicate membership
  is removed within each layer while products can occur under several layers.
  Layer selection uses product IDs. Visibility uses drawable IDs and existing
  assembly-part substitution. Parsed and builder regressions assert both sides.
- Ownership follows explicit representation, map, boolean, generating curve,
  profile, shell, face, loop, vertex, tessellation and annotation-fill references.
  The finite native-consumer audit includes individual polygonal faces and spline
  control points. Frames, directions, axes, styles and contexts are excluded.
  Inherited operand tables are unioned; subtype directrices do not erase profiles.
- IFC4/IFC2X3 offset curves can directly extend IfcCurve, while IFC4X3 adds the
  IfcOffsetCurve base. Explicit concrete roots cover both layouts. Parsed tests
  exercise 2D/3D offset forms and IFC4X3 curve-segment parent ownership.
- Shape aspects connect their shape models back to a validated product-definition
  shape or representation map, matching the [buildingSMART schema](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcShapeAspect.htm).
  The inverse ownership shortcut validates effective owner and child classes;
  dangling, unrelated, deleted and retyped resources cannot create those links.
- Traversal and nested-reference flattening are iterative with visited sets.
  Effective metadata reads use the canonical accessor and one build-local cache.
  Assigned seeds require existing effective representation/item classes. Tests
  cover cycles, dangling references, shared geometry, placement-only negatives,
  creations, deletions, retypes, named edits and positional precedence/clearing.
- Stores are grouped by source identity and renderer ID offset. Reusing a parsed
  store across distinct registered model ranges retains separate assignments,
  attribution, selection and assembly visibility IDs. Shared IFCX aliases with
  the same zero offset still project once with all owners and no false badge.
  A parsed regression uses one store and two actual registry allocations; the
  shared-zero-offset regression remains unchanged. Browser federation evidence
  also covers colliding local IDs and repeated names.
- Mixed rows advertise Show when their existing action reveals members. The
  callback, icon, accessible label and tooltip share the same action calculation
  over exact getNodeElements IDs. Fully-hidden styling remains separate, including
  drawable assembly parts. A mounted regression covers mixed, shown and hidden.
- Curve-only annotation owner IDs participate in hide/show. Space/zone isolation
  enables the existing default-hidden spatial type when needed. Symbolic overlays
  retain their existing global visibility/isolation behavior; this feature does
  not introduce annotation-only isolation semantics.
- The builder is imported on demand and caches code, never model snapshots.
  Cleanup suppresses callbacks after tab changes/unmounting; rejected imports
  clear the pending promise and expose localized Retry. Loading suppresses false
  empty/search states. A cold-load mounted regression covers leaving/reentering
  the tab and revealing a held selection after the import completes.
- Final metadata readiness distinguishes active missing metadata from settled
  geometry-only or failed models. Available sibling rows remain browsable while
  another model loads; source ownership never falls back to an unrelated active
  store. Mounted progressive cases verify busy/search-empty behavior, genuine
  completed emptiness, terminal models, available-product selection during sibling
  hydration and held selection after completion. Both initially pending models
  explicitly keep the tree busy until metadata settles.
- An unresolved outside-selection target is keyed by ID, selection revision and
  grouping, and retried only against a changed tree lookup. Resolving retires the
  request permanently; later geometry or sibling metadata cannot reopen a manual
  collapse. Selection/deselection/tree-click activation clears stale requests.
  Mounted regressions cover held selection before either metadata store exists,
  arrival while a sibling stays pending, no redispatch, later manual collapse,
  and cancellation by a different tree selection.

## Evidence and validation provenance

The reviewer opened all committed acceptance screenshots through the finite
geometry-audit revision, including [selected products](selected-layer.png),
[isolation](isolated-layer.png), [federation](federated-selection.png), annotation
[shown](annotation-layer-shown.png)/[hidden](annotation-layer-hidden.png),
[shape-aspect selection](shape-aspect-selection.png) and [mixed visibility](mixed-visibility.png).
They show the original Archicad model and explicitly documented derived regression
variants. The reviewer inspected images rather than independently driving the
browser; the lead agent performed the interactions recorded in [README](README.md).

The lead agent reported passing focused tests, root typecheck/test-file audit,
lint, production build and unchanged bundle ceilings at preceding source revisions.
Final bounded-reveal validation was running when this report was updated;
final commands, counts, browser results and bundle measurements belong in the
README and raw evidence. This review does not claim independent heavy-test runs.
Browser use of the fetched published WASM runtime and the local regeneration
limitation are disclosed in the README; no additional runtime-equivalence claim
is made here. Source changes are viewer-only; no Rust/kernel behavior changed.

Final integration addendum: independently reviewed `9680664cb9a6977fdf09c729c1251505a888f483`, which changes only the Elements ribbon glyph to the existing house `Layer` SVG. Its import now satisfies the existing ribbon design contract; command labels, dispatch and hierarchy behavior are unchanged. The corrected E2E inventory and actual sidebar activation assertions were also reviewed at `b12aa4d8e5`. Related registry and localization contracts use dynamic inventories; no further concrete omission or unresolved blocker was found. Final CI execution remains a separate requirement.
