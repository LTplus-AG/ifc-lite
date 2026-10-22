# ifc-git: Graph-Based Version Control for IFC

**Spec set: Draft v0.1, for discussion. Owner: Bruno Adam. Tracking: [#8038](https://github.com/LTplus-AG/ifc-lite/issues/8038).**

> **Status: skeleton.** No code exists, and none of the specs in the reading map
> below are written. This document states the direction and names the decisions
> that have to be made before anything is built. Read §6 first if you are short
> of time: it is the part that needs an answer.

## 1. North star

A delivered IFC file arriving from outside ifc-lite has no history. ifc-git gives
it one: **every delivery becomes a commit**, and the commit is computed from the
**diff against its parent** rather than from the file bytes, so an unchanged
re-export creates no new history.

It is used the way git is used — on the CLI to ingest files, and headlessly to
diff — and it exposes the operations people already know: `status`, `commit`,
`branch`, `diff <a> <b>`, `log`, `pull`, `push`.

It is written in **Rust**, because the work is per-entity hashing and graph
comparison over models with hundreds of thousands of entities, and that is where
the time goes.

## 2. The three decisions that define it

**1. Graph-based version control.** The versioned object is the IFC **graph**,
not the file and not a line range. History is a DAG of graph states; change
detection is graph analysis. This follows the line of work by Esser,
Vilgertshofer and Borrmann (§7).

**2. GUID-agnostic diff.** A node's identity is its **content plus its
structural position**, not its `GlobalId`. A re-export that regenerates every
`GlobalId` while changing nothing must read as unchanged. `GlobalId` remains
useful evidence — it is simply not the identity.

**3. Change is localised at the node.** Change one property inside one property
set, and the change belongs to **that property-set node**. The owning object is
merely *marked* as "pset changed". The change is not attributed to the file, and
not to the whole element.

That third point is the one that makes the rest work. Because a property set is
its own node, a set shared by many occurrences that changes once is **one** node
change plus N markers, rather than N independent element changes.

## 3. Scope

- **Schemas:** IFC2X3, IFC4, IFC4X3 and IFC5/IFCX, from the start. These differ
  in ways that matter here — most sharply, `IfcRoot.OwnerHistory` is mandatory in
  IFC2X3 and optional from IFC4 on, and IFC5/IFCX has no `IfcOwnerHistory` at all.
- **Entities:** both **occurrences and type objects**. A change confined to an
  `IfcWallType` is a change.
- **Granularity:** element level, with the change localised to the node that
  carries it.

## 4. Relationship to the spec sets that already exist

This is the section worth disagreeing with early.

Two version-control spec sets are already in the tree or on a branch, and
ifc-git is **independent of both, deliberately**:

| Spec set | Versions | Status |
| --- | --- | --- |
| [Layer PRs](../layer-prs/index.md) | Edits made *inside* ifc-lite, as immutable IFCX overlay deltas | Draft v0.1, substantially implemented: refs and ref policies, three-way merge, rebase, revert, review workflow, blake3 content addressing |
| `docs/architecture/commit-history/` (branch `docs/commit-history-specs`) | *File revisions read from a commit service* | Draft, implemented on a parked branch |
| **ifc-git** | **The IFC graph of whole authored deliveries**, with GUID-agnostic node identity | This document |

Why independent rather than folded in: Layer PRs versions *deltas authored in
ifc-lite against a known base*, and its unit of change is an opinion in an
overlay. ifc-git versions *whole IFC files authored elsewhere*, where there is no
overlay, no known base, and no author at hand — the diff against the parent is
the only thing that says what changed. The two meet at the component-key
vocabulary, which is already shared between `@ifc-lite/diff` and
`@ifc-lite/merge` and which ifc-git keeps.

**ifc-git supersedes `@ifc-lite/merge` once mature.** Per the anti-cruft rule in
`AGENTS.md`, that means the old path is deleted when the new one lands, not left
alongside it. Until then `@ifc-lite/merge` is untouched.

The commit-aware source work stays parked and is **not a dependency**.

## 5. Reading map

Every spec below is **planned, not written**. They land one per PR, in roughly
this order.

| Doc | Contents |
| --- | --- |
| `01-concepts.md` | Glossary: org, repo, commit, tree, blob, ref, branch. Repo kinds. What maps onto git and what cannot. |
| `02-graph-object-model.md` | The node DAG. Node kinds and component keys. Canonical encoding. Why this is GUID-agnostic. |
| `03-diff.md` | Diff as the commit computer. Graph diff and change localisation. The Rust port and its parity contract. |
| `04-authorship.md` | The schema-neutral authorship record and its per-schema adapters. Resolution ladder, warning codes, and the rule against fabricated attribution. |
| `05-operations.md` | The verb surface: `status`, `commit`, `branch`, `diff <a> <b>`, `log`, `pull`, `push`. What each means for a graph rather than a tree of text files. |
| `06-refs-and-history.md` | Branches, compare-and-swap on the head, rebase, revert, tags. |
| `07-storage.md` | Object store interface, loose and packed tiers, on-disk layout. |
| `08-ui.md` | A source-control view in the viewer, modelled on the one developers already use. |
| `09-relationship-to-layer-prs.md` | The boundary in detail, and what superseding `@ifc-lite/merge` requires. |

## 6. Open decisions

**These are maintainer calls. The skeleton records them as open rather than
assuming an answer, and neither blocks PRs 1 or 2.**

### 6.1 node-hash v0, or a v1?

`packages/provenance/SPEC.md` already specifies the exact primitive ifc-git
needs. Node-hash v0 is a Merkle DAG over the IFC graph: `property-set` is "a leaf
w.r.t. geometry, composite w.r.t. its own properties", `element` hashes "its
`geometry-mesh` hash if any, its `property-set`/`qset` hashes, its
`relationship`…", every composite is "hash my own fields plus my children's
hashes", and set-valued fields are canonically sorted.

That **is** the localisation rule in §2.3, and because a node's id is its content
plus its children's ids, it is GUID-agnostic by construction. It also already has
a canonical binary encoding, a frozen wire format and golden vectors.

Two frictions:

- v0 uses **two digests** — SHA-256 for composites, FNV-1a-64 for
  `geometry-mesh` leaves — where one algorithm is wanted throughout.
- v0 is **FROZEN** (2026-07-25), and unfreezing is not a decision to take
  quietly.

In its favour: v0 has **no consumers outside its own package**, so a v1 costs
nothing in compatibility.

**Proposal:** a node-hash v1 that changes **only the digest function**, to
BLAKE3 — already this repo's content-address algorithm, via `computeLayerId` and
`computeStackHash` in `packages/ifcx/src/canonical.ts` — and keeps v0's canonical
structure, kind tags, sorting rules and golden-vector methodology unchanged. v0
stays in place for the determinism-certificate work it was built for. BLAKE3 is
chosen over the faster non-cryptographic options because a content address must
be collision-resistant: an attacker-supplied IFC must not be able to forge a node
id.

**If v0 should stay frozen and be used as-is, say so** — ifc-git can live with
two digests, and the structure is what matters.

### 6.2 What "reuse git's implementation" can mean here

Reusing the real thing is attractive and mostly not possible:

- **git is GPL-2.0.** Its source cannot enter an MPL-2.0 tree.
- **libgit2 is GPL-2.0 with a linking exception.** The exception permits linking,
  not copying source in.
- **`gitoxide` (`gix-*`) is MIT OR Apache-2.0** and is the only
  license-compatible route to reusing git implementation code. But
  `gix-hash::ObjectId` is SHA-1 (SHA-256 planned), so under §6.1's proposal its
  object, ref and pack plumbing cannot be used as-is.

**Proposed position**, to be written into `07-storage.md`:

- Reuse git's **designs**, which are not copyrightable: the loose-object plus
  packfile two-tier store, ref updates via lockfiles, the reflog, the
  index/staging model, and compare-and-swap against an expected parent.
- Depend on `gix-*` only for **hash-agnostic utilities** that pull their weight,
  evaluated per crate.
- **Never copy from git or libgit2.**

## 7. Research

Cited as background. **No paper is implemented from, and no paper's code is
ported.**

Primary direction:

- Esser, S., Vilgertshofer, S., & Borrmann, A. (2022). Graph-based version
  control for asynchronous BIM collaboration. *Advanced Engineering Informatics*,
  53, 101664. doi:10.1016/j.aei.2022.101664
- Esser, S., Vilgertshofer, S., & Borrmann, A. (2023). Version control for
  asynchronous BIM collaboration: Model merging through graph analysis and
  transformation. *Automation in Construction*, 155, 105063.
  doi:10.1016/j.autcon.2023.105063
- Esser, S. (2022). Graph-Based Version Control of BIM Models in an Event-Driven
  Collaboration Environment. *Engineering Proceedings*, 17(1), 7.
  doi:10.3390/engproc2022017007

On GUID-agnostic change detection:

- Wang, Z., Du, C., Liu, Q., & Borrmann, A. (2026). BIMdiff: Object-Level BIM
  Change Detection with Identifier Reconciliation. doi:10.2139/ssrn.6501624
- Shi, X., Liu, Y.-S., Gao, G., Gu, M., & Li, H. (2017). IFCdiff: A content-based
  automatic comparison approach for IFC files. *Automation in Construction*, 86,
  53–68. doi:10.1016/j.autcon.2017.10.013

On incremental storage:

- Liu, H., Gao, G., & Gu, M. (2023). A Parallel IFC Normalization Algorithm for
  Incremental Storage and Version Control. arXiv:2312.14931

## 8. Delivery plan

One PR per row, each well inside the ~1,500-line limit.

| # | PR | Depends on |
| --- | --- | --- |
| 1 | **This docs skeleton** (`index.md` + mkdocs nav) | none |
| 2 | Rust crate scaffold | 1 |
| 3 | **Port the diff engine to Rust**, faithfully: byte-exact parity against the TypeScript engine on real fixtures, `@ifc-lite/diff` keeping its public API | 2 |
| 4 | `01-concepts.md`, `02-graph-object-model.md`, `03-diff.md` | 1, §6.1 answered |
| 5 | Graph node model in Rust: GUID-agnostic node identity, with the existing content-match tiers as its reconciliation fallback | 3, 4 |
| 6 | Authorship extraction across the four schemas | 5 |
| 7 | Object store and refs: commit, branch, compare-and-swap on the head | 5, §6.2 answered |
| 8 | The verb surface: `status`, `commit`, `branch`, `diff <a> <b>`, `log` | 7 |
| 9 | `pull` / `push` against a remote | 8 |
| 10 | Source-control view in the viewer | 8 |

PR 3 is the first substantial one, and is deliberately a **faithful port rather
than an algorithm change**: parity is testable, so the risk stays bounded. The
GUID-agnostic identity of §2.2 arrives in PR 5, on top of a port whose behaviour
is already pinned.

## 9. Out of scope for v1

- The commit-aware source API and the parked branch that implements it.
- **Persistence of any kind.** Staging is in memory and does not survive a
  session, exactly as the mutation overlay behaves today.
- Automatic merging of two authored IFC files. Merge between authored deliveries
  is advisory and reported object by object; it never writes a merged file.
  Rebasing an overlay onto a new base is a separate, real operation.
- The viewer UI, beyond the sketch in `08-ui.md`.

## 10. Working agreements

Inherited from [`AGENTS.md`](https://github.com/LTplus-AG/ifc-lite/blob/main/AGENTS.md), and
called out because this spec set touches each:

- **Strict IFC nomenclature** in user-facing APIs: exact EXPRESS names,
  PascalCase attributes, full `IfcRel*` relationship names.
- **Supersede means delete.** When ifc-git replaces `@ifc-lite/merge`, the old
  path goes in the same PR. No parallel version-control stacks.
- **Rust is not self-policed**: `cargo clippy --workspace --all-targets -- -D warnings`
  is a hard gate, and `cargo test --workspace` rather than `cargo check`.
- **Module and function size are ratcheted** — ~400 lines per module,
  150 per function. Prefer splitting to allowlisting.
- **MPL-2.0 header on every new source file**; changesets for published packages.
- **This repository is public.** No client, partner or internal system names in
  code, docs, fixtures, tests, commit messages or PR text. A responsibility
  matrix is an injectable interface, never a named system; a connected document
  management system is "a CDE connector"; a classification system is "a
  classification code".
