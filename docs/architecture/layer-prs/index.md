# Layer PRs: Version Control for Building Models

**Spec set: Draft v0.1, target ifc-lite 4.0. Owner: Louis Trümpler (LT+).**

## North star

Every change to a building model, whether made by a human in a viewer, a script in CI, or an AI agent in an MCP session, lands as an **immutable, provenance-stamped IFCX overlay layer**. Integrating a layer into the shared model is a **review workflow**: semantic diff, required checks, per-entity accept/reject, full audit trail.

> **No agent writes to main. Agents propose. Humans merge.**

The endgame is bigger than a feature: a content-addressed, federated change graph for the built environment. Git gave software branching, review, CI, and an ecosystem (forges, registries, bots). Buildings get the same, but the unit of change is semantic (entity, component, opinion) instead of textual (line), and non-human authors are first-class from day one. Whoever defines this layer (format, provenance, merge semantics) defines how AI enters AEC. This spec set is that definition, built openly on IFCX so it can become a buildingSMART standard rather than a vendor moat.

## Why IFClite is the place this happens

The repo already converged on the primitives without naming the product:

- `@ifc-lite/ifcx` composes USD-style layer stacks (`layer-stack.ts`, `composition.ts`)
- `@ifc-lite/diff` ships a store-agnostic, fingerprint-based entity diff engine
- `@ifc-lite/collab` ships CRDT sessions, branching starters, conflict detection, and `extractMinimalLayer` (a differential layer composer, additive-only)
- `@ifc-lite/mutations` ships change sets; `@ifc-lite/ids` ships validation; `@ifc-lite/bcf` ships the review-comment substrate
- `@ifc-lite/extensions` ships a capability grammar with risk tiers, audit, and dry-run: the security model for non-human authors already exists
- `@ifc-lite/mcp` ships the agent surface

`branch.ts` and `minimal-layer.ts` both carry docstrings deferring exactly the pieces specified here (differential composer, deletion overlays). This spec set closes those deferrals and composes everything into one product.

## Reading map

| Doc | Contents |
|---|---|
| [01-concepts](01-concepts.md) | Glossary, the two-tier change model, everything-is-a-layer |
| [02-layer-format](02-layer-format.md) | Op model, tombstones, canonical serialization, content addressing |
| [03-provenance](03-provenance.md) | Manifest schema, signatures, trust model |
| [04-identity](04-identity.md) | Entity identity across layers, identity_map, fallbacks |
| [05-merge](05-merge.md) | Three-way merge, conflict taxonomy, rebase, derived data and geometry tiers |
| [06-agents](06-agents.md) | MCP draft-layer lifecycle and tool family |
| [07-security](07-security.md) | Capability scoping, enforcement points, threat model, audit |
| [08-review](08-review.md) | Review workflow, viewer UI, BCF, required checks, Time Machine DAG |
| [09-cli](09-cli.md) | `ifc layer` command reference, GitHub Action |
| [10-registry](10-registry.md) | Hosted layer registry, federation, policies, product tiers |
| [11-standards-ecosystem](11-standards-ecosystem.md) | IFCX panel strategy, ecosystem integrations, competitive positioning |
| [12-roadmap](12-roadmap.md) | Implementation plan and task tracker (collab-plan.md format) |

## Working agreements (inherited from AGENTS.md / collab-plan.md)

- Strict IFC nomenclature in user-facing APIs; Pset and property names in PascalCase
- Federation-aware IDs: never bypass `FederationRegistry` for cross-model lookups
- MPL-2.0 license headers on every new `.ts` / `.rs` file; changesets for published packages
- File size cap ~400 LOC; no `as any`; tests required for every new package and feature
- Every phase ships behind a feature flag (`layers.enabled`) and lands on `main` only with green exit criteria
