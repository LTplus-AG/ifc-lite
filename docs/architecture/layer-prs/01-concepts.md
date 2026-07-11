# 01: Concepts and Glossary

## 1.1 Glossary

| Term | Definition |
|---|---|
| **Base** | The composed state a layer was authored against: either a single published layer id or a **stack hash** (blake3 over the ordered list of layer ids in a composition) |
| **Draft layer** | A mutable, CRDT-backed working set (a `CollabSession` Y.Doc) bound to a base. Multiple humans and agents may co-edit one draft live |
| **Published layer** | An immutable, content-addressed IFCX document containing only deltas against its base, plus a provenance manifest. Produced by freezing a draft |
| **Opinion** | A single (path, attribute, value) assertion in a layer, USD terminology, already used by `ifcx/composition.ts` |
| **Tombstone** | An opinion asserting deletion of an entity or component (02 §2.3) |
| **Merge layer** | A published layer that records the integration of a candidate layer into a base: auto-merged ops, conflict resolutions, resolver identity |
| **Main** | A named ref pointing at a stack hash: the team's agreed composed state. Refs are mutable pointers; everything they point at is immutable |
| **Check** | A pure function over a composed state producing a pass/fail report (IDS validation, schema, clash, custom). Reports are content-addressed and attached to manifests |
| **Scope claim** | A capability-grammar expression in the manifest declaring what the layer touches (07) |

## 1.2 The two-tier change model

The single most important architectural decision. Two kinds of concurrency, two tools:

**Inside a draft: CRDT.** Keystroke-level concurrency between co-editors of the *same intended change* is resolved by Yjs LWW convergence, exactly as `@ifc-lite/collab` does today. The conflict detector stays advisory. Nothing here changes.

**Between layers: review.** Integration of *different intended changes* is never auto-merged by default. CRDTs guarantee convergence, not correctness: two structurally mergeable edits can be semantically incompatible (wall moved vs door re-hosted in that wall). At integration boundaries, conflicts become explicit records resolved by a reviewer or a policy, and checks gate the result. `mergeBranch(strategy: 'ops')` from `collab/branch.ts` is demoted to an explicit opt-in fast-forward for trusted same-team flows.

Analogy: Git does not push on every keystroke. Your editor buffer converges freely; integration is deliberate.

## 1.3 Everything is a layer

One primitive, no special cases:

- An edit session publishes a layer
- A merge produces a merge layer (resolutions are ops)
- A revert is a layer of inverse ops
- An import (e.g. Motif native IFC import, a Revit export) is a base layer
- A check waiver is recorded in the merge layer manifest
- A rename/identity correction is an `identity_map` entry in a layer manifest

History is therefore an append-only DAG of content-addressed layers. Any node is reproducible by composing its ancestry. BCF Time Machine renders this DAG directly (08 §8.5).

## 1.4 What this is not

- Not operational transform: ops are state-based per component key (02 §2.2), composition is a deterministic fold
- Not file versioning: a layer references entities by stable identity, not byte ranges
- Not a lock server: concurrency is unrestricted; correctness is enforced at integration
- Not IFClite-proprietary: every published layer is a valid IFCX document; the manifest lives in one extension namespace (11 §11.1)
