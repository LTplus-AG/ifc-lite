# Independent adversarial review — #7619

Reviewed implementation commit `0562613208d6cb13afb6df69a81c7a71753fbc79`
against base `f1d7254b73` on 2026-10-15. This report is a subsequent
documentation-only artifact; its own commit is outside the implementation
revision named above.

Verdict: no unresolved correctness blocker found in the reviewed implementation.
This verdict does not replace required CI or the maintainer's merge decision.

## Scope and method

An independent reviewer read the agreed specification, the complete production
diff, all three new test files, existing hierarchy selection/reveal/action
helpers, effective entity enumeration and metadata accessors, and the committed
browser evidence. The reviewer did not author production changes. Findings were
sent directly to the implementation agents and their final repairs were reread
at the exact commit above. `git diff --check f1d7254b73 0562613208` passed.

The review examined duplicate names and local IDs, many-to-many membership,
shared mapped representations, cyclic geometry, nested structural ownership,
unrelated shared placements/contexts, invalid assignment references, current
mutations and retypes, legacy and federated IDs, shared IFCX stores, assembly
geometry, default-hidden spatial products, search/reveal, empty states,
localization and six-tab layout.

## Findings repaired before this revision

- Layer rows now participate in aggregate hidden-state computation. The final
  `HierarchyNode` change makes the eye icon, accessible action label and tooltip
  read the same computed `nodeHidden` value instead of the structural
  `node.isVisible` flag. The mounted test verifies Hide followed by Show.
- Isolating a layer containing a default-hidden space enables the corresponding
  spatial type visibility. Product types are resolved through existing entity
  ownership and mutation accessors; a mounted regression covers this case.
- Shared IFCX stores are projected once, retain all owner IDs without a false
  single-model badge, and consider geometry readiness across their owners.
  A builder regression exercises a metadata-only first owner.
- Assignment ownership covers representation subclasses, mapped and boolean
  geometry, and explicit nested set/curve/shell/face structure. It does not walk
  arbitrary context, placement or styling references. Traversal and reference
  flattening are iterative with visited sets.
- Assigned seeds must exist and have an effective representation/item class.
  Tests exercise a dangling ID also referenced by a shape and an assigned solid
  retyped to a property set; neither manufactures product membership.
- Effective metadata reads use the existing canonical mutation accessor and a
  build-local record cache. Tests cover names, named and positional clearing,
  positional precedence, created/deleted assignments and deleted products.

Whole-product selection remains distinct from visibility geometry: layer
selection uses member IDs, while visibility/isolation substitute drawable
assembly parts through the existing assembly resolver. Builder tests explicitly
assert that distinction and repeated-product row identity.

## Evidence assessed and limits

The reviewer opened all three committed screenshots. [Selected layer](selected-layer.png)
shows 21 selected products with the inspector reporting 11 windows, 8 walls and
2 doors. [Isolated layer](isolated-layer.png) shows the exterior wall/window/door
geometry, 21 isolated elements, 61 hidden elements and all six labelled tabs.
[Federated selection](federated-selection.png) shows 164 loaded elements, 22
assignment rows, distinct repeated layer rows and 21 selected products attributed
to the second model. The narrow screenshot shows all six icon tabs. These are
consistent with the real Archicad acceptance outcomes documented in [README](README.md).
The reviewer inspected screenshots rather than independently driving the browser.

The lead agent reported 47 focused tests passing without skips, all 126 root
typecheck tasks passing, and the static gate results recorded in the README.
The reviewer inspected the assertions but did not rerun heavy validation in
parallel. Full lint and required remote CI remained the delivery agent's
responsibility at the time of this review. Browser use of the fetched published
WASM runtime, and the local wasm-pack regeneration limitation, are explicitly
disclosed in the README; this review makes no additional runtime-equivalence
claim.

Any subsequent production-code change requires review of its delta before this
verdict can be applied to a newer head.
