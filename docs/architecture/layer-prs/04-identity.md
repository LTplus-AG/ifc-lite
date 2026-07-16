# 04: Entity Identity

The persistent-naming problem is the graveyard of model-diff projects. This spec survives it by refusing to be clever in v1.

## 4.1 Identity sources, in priority order

1. **IFC GlobalId** (the `key` already used by `@ifc-lite/diff`): primary identity wherever present and stable
2. **Explicit identity_map** (03 §3.1): a layer may declare "entity X in base = entity Y here". Identity becomes a reviewable claim in the manifest instead of a heuristic buried in an engine
3. **Content-derived fallback**: blake3 over a stable subset of `DataFingerprintInput` (ifcType + spatial parent path + name) for entities with missing or untrustworthy GlobalIds. Always recorded into `identity_map` with `reason: "derived"` so a human can override

There is **no** v1 heuristic matcher (no geometry-similarity, no attribute-distance matching). When identity cannot be established, the diff honestly reports delete + add, and the review UI offers a one-click "same entity" action that writes an `identity_map` entry. Human-in-the-loop identity beats wrong automatic identity.

## 4.2 Federation

Cross-model lookups go through `FederationRegistry` (AGENTS.md invariant). A layer targets exactly one model's identity space; federated multi-model changes are multiple layers grouped by a shared `session` in their manifests. The registry can render the group as one logical PR (10 §10.3).

## 4.3 expressId bridge

`@ifc-lite/mutations` records `Mutation.entityId` as an expressId (model-scoped, unstable across exports). The publish path maps expressId → GlobalId via the store's id table at freeze time (`packages/mutations`: new `change-set-to-ops.ts`). Entities without GlobalIds take path §4.1(3).

## 4.4 Geometry tiers

Identity attaches to the semantic (P-tier) entity only. Derived tiers (tessellation, BVH, 2D projections) never carry independent identity: they are keyed by (entityId, componentKey, inputsDigest) and recomputed after merge (05 §5.6). This is the layer-PR system's strongest argument *for* the tier separation in the geometry-tiers work: merge correctness requires a tier whose identity is stable and whose derived artifacts are disposable.

## 4.5 Later (explicitly out of v1)

- Heuristic matching as a *suggestion provider* for the review UI (never silent)
- Cross-schema identity (IFC2X3 ↔ IFC4 migrations as identity-preserving layers)
- Type-entity identity dedup across federated models
