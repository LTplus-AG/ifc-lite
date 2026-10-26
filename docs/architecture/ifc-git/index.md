# ifc-git: Graph-Based Version Control for IFC

**Spec set: Draft v0.1, for discussion. Owner: Bruno Adam. Tracking: [#8038](https://github.com/LTplus-AG/ifc-lite/issues/8038).**

> **Status: early draft.** `01-concepts.md` and `02-graph-object-model.md` are
> written; the rest of the reading map below is planned. This document states
> the direction and names the decisions that still have to be made. Read §6
> first if you are short of time: it is the part that needs an answer.
>
> One foundation is already built rather than proposed: the Rust diff engine
> landed under #8042 while this was in draft (§8). Nothing else here is
> implemented.

## 1. North star

A delivered IFC file arriving from outside ifc-lite has no history. ifc-git gives
it one: **every delivery that changed something becomes a commit**, and the
commit is computed from the **diff against its parent** rather than from the
file bytes, so an unchanged re-export creates no new history — it is recorded as
pointing at the commit that already exists.

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

**2. GUID-agnostic diff.** A node's address is its **own content plus the
addresses of its children**, not its `GlobalId`, and the entity key lives in the
**tree** that points at the node rather than in the node itself (02 §2.4).
Nothing about a node's position in the graph reaches its address. A re-export
that regenerates every `GlobalId` while changing nothing must read as unchanged.
`GlobalId` remains useful evidence — it is simply not the identity.

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

### Owner-history semantics already exist on the write side

`04-authorship.md` should align with #8154 rather than re-derive it. That change
made the exporter attribute what it writes, and its rules are the ones ifc-git
wants:

- one `ADDED` owner history for everything an export adds, owned by the
  **exporting application**;
- one `MODIFIED` history **per distinct original**, keeping the original owner
  and creation date;
- and where no identity is available, the source's attribution is left alone and
  a finding is reported — never replaced with the exporter's own.

That last rule is the anti-fabrication principle this spec set states for the
read side, arrived at independently on the write side. The finding text says it
plainly: without an exporting application, "the file credits this export's
changes to their previous author". Where a modified record has no owner history
at all, the export reports that "the modification is not recorded on it" rather
than inventing one — a guard that both acts and reports.

The mapping onto ifc-git is close to exact: the **preserved original owner is
the author** (responsible for the content) and the **exporting application is
the committer** (performed the write). So `ChangeAction` is now meaningfully
*written* in this repo, even though it is still not *read* into the model —
which is the gap `04-authorship.md` has to close, and it should close it toward
these semantics.

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

`01-concepts.md` and `02-graph-object-model.md` are written. The rest are
planned, and land one per PR in roughly this order.

| Doc | Contents |
| --- | --- |
| [`01-concepts.md`](01-concepts.md) | Glossary: org, repo, commit, tree, blob, ref, branch. Repo kinds. What maps onto git and what cannot. |
| [`02-graph-object-model.md`](02-graph-object-model.md) | The node DAG. Node kinds and component keys. Canonical encoding. Why this is GUID-agnostic. |
| `03-diff.md` | Diff as the commit computer. Graph diff and change localisation. The Rust port and its parity contract. |
| `04-authorship.md` | The schema-neutral authorship record and its per-schema adapters. Resolution ladder, warning codes, and the rule against fabricated attribution. |
| `05-operations.md` | The verb surface: `status`, `commit`, `branch`, `diff <a> <b>`, `log`, `pull`, `push`. What each means for a graph rather than a tree of text files. |
| `06-refs-and-history.md` | Branches, compare-and-swap on the head, rebase, revert, tags. |
| `07-storage.md` | Object store interface, loose and packed tiers, on-disk layout. |
| `08-ui.md` | A source-control view in the viewer, modelled on the one developers already use. |
| `09-relationship-to-layer-prs.md` | The boundary in detail, and what superseding `@ifc-lite/merge` requires. |

## 6. Open decisions

**These are maintainer calls. This spec set records them as open rather than
assuming an answer, and neither blocks the documents written so far.**

§6.1 is **decided** as of 2026-10-26 and kept here with its reasoning rather
than deleted, because the argument is what a later reader needs. §6.2 is open.

### 6.1 The digest, and where the encoding lives — DECIDED

**Decided 2026-10-26: BLAKE3, and the encoding is specified and implemented in
`rust/git` rather than as a `node-hash-v1.md` under `@ifc-lite/provenance`.
Node-hash v0 stays frozen and untouched.** The reasoning that led there follows,
including the part of it that changed.

`packages/provenance/SPEC.md` already specifies most of the primitive ifc-git
needs. Node-hash v0 is a Merkle DAG over the IFC graph: `property-set` is "a
leaf w.r.t. geometry, composite w.r.t. its own properties", every composite
hashes its own fields plus its children's hashes, set-valued fields are
canonically sorted, and the `element` node is a fold of per-component-key child
hashes **sorted by `componentKey`**, over the same vocabulary as
`packages/diff/src/fingerprint.ts`. That fold *is* the change-localisation rule
of §2.3, already specified and already pinned by golden vectors.

**But v0 is not GUID-agnostic, and an earlier draft of this document wrongly
said it was.** §3.2 encodes the `element` node as:

> header, `key` (string — the entity's stable identity, typically `GlobalId`),
> `ifcType` (string), `componentCount` (u32), then components sorted by
> `componentKey` …

`key` is inside the hashed byte stream, so a from-scratch re-export that
regenerates every `GlobalId` changes every element node hash, and therefore the
tree, and therefore the commit — which is precisely the case §2.2 exists to
make invisible. The non-element kinds are already content-only and need no
change; the problem is confined to `element`.

So a v1 is **not** a digest swap. Two changes are wanted, and the second is the
substantive one:

1. **One digest throughout — BLAKE3.** v0 uses SHA-256 for composites and
   FNV-1a-64 for `geometry-mesh` leaves. Two algorithms is already one too many,
   and one of them is not a cryptographic hash: FNV is excellent for hash tables
   and trivially collidable on purpose, which is acceptable for a cache key and
   not for an identity an approval can rest on. A content address must be
   collision-resistant, because an attacker-supplied IFC must not be able to
   forge a node id.

   BLAKE3 was chosen on a measurement rather than on published throughput
   figures, because those describe one long stream and this workload is the
   opposite: one hash per node, a few hundred bytes each, hundreds of thousands
   of them. Measured against a hardware-accelerated SHA-256 (`sha2` 0.10.9 with
   its runtime feature detection, aarch64):

   | Input | BLAKE3 | SHA-256 | Ratio |
   | --- | --- | --- | --- |
   | 200 B, a typical component node | 84 ms | 179 ms | 2.1x |
   | 600 B, an element node | 196 ms | 446 ms | 2.3x |
   | 32 KB, a tree chunk | 72 ms | 272 ms | 3.8x |

   400k iterations at the two small sizes, 5k at chunk size. BLAKE3 is also
   already this repo's content-address algorithm via `computeLayerId` /
   `computeStackHash` in `packages/ifcx/src/canonical.ts`, so choosing it leaves
   one algorithm in the tree rather than adding a third.

   **Not measured: wasm32.** BLAKE3 1.x ships SSE/AVX and NEON backends but no
   `simd128` one, so the browser path runs its portable implementation while
   `.cargo/config.toml` enables `simd128` for everything else. The ordering is
   not in doubt — BLAKE3's compression function is cheaper per byte than
   SHA-256's, and neither gets hardware help in wasm — but the ratio is, so
   measure before a browser-diff performance claim rests on it.
2. **Move `key` out of the element hash and into the tree.** The node address
   becomes content-only; the commit's tree maps `key → node address`. This is
   exactly git's arrangement — a blob is content, a tree maps names to blobs,
   and two identical files share one blob. GUID-agnosticism then falls out
   rather than being engineered: compare node addresses to find what changed,
   and consult keys only to pair nodes across versions, where a re-GUID reads as
   the rename case the shipped content-matching tiers already resolve. It also
   buys deduplication of genuinely identical content for free.

**The freeze is not the obstacle it looks like.** v0's own change policy
provides the path: any wire-format change "requires a **new versioned spec
file** (`node-hash-v1.md`, with a new magic/version byte) and a **major version
bump of `@ifc-lite/provenance`**". So a v1 is a specified move, not an act of
unfreezing — v0's bytes, golden vectors and `NHV0` magic stay untouched and keep
serving the determinism-certificate work they were built for. v0 also has no
consumers outside its own package today, so the major bump costs nothing.

**What needed deciding** was therefore narrower than "unfreeze or not": whether
ifc-git should author `node-hash-v1.md` under `@ifc-lite/provenance` as the
spec's change policy directs, or define its node encoding in `rust/git` and
leave `@ifc-lite/provenance` alone entirely.

An earlier draft of this section recommended the first, on the ground that two
Merkle encodings over one IFC graph is the duplication the anti-cruft rule
exists to prevent. **That ground is sound and the conclusion drawn from it was
wrong**, for a reason the draft did not weigh: the rule targets two *live
encodings*, not a spec file's directory. v0 stays frozen and keeps serving the
determinism certificates either way, so neither option removes it; and ifc-git's
encoding is not v0 with a different digest. It changes what a node *means* —
the element node carries no `key` at all, which is the whole GUID-agnostic
mechanism, and child references are raw digest bytes rather than v0's tagged
hash strings (§2.5). Authoring that as "v1" of v0 would imply it supersedes v0
for provenance's own purposes, which it does not.

It would also put the normative spec in a TypeScript package with no runtime
dependencies, for a format implemented only in Rust, and charge that package a
major version bump for the privilege.

**Decided: one format, specified where it is implemented.** `rust/git` owns the
encoding, with its own magic bytes and version byte (`IGN1`, `IGT1`, version 0)
so it can evolve on its own clock, and the normative description lives in this
spec set beside the reasoning for it. `packages/provenance/SPEC.md` should gain
a pointer to it, so that nobody writes a third encoding for want of knowing this
one exists.

**Still open, and genuinely a maintainer call:** whether `@ifc-lite/provenance`
should later *adopt* this encoding and retire v0. That is a migration of a frozen
published format with golden vectors in CI, it is Louis's to make, and nothing
in ifc-git forces it.

### 6.2 What "reuse git's implementation" can mean here

Two separate questions, which an earlier draft of this section ran together.

**Licence, which constrains copying source:**

- **git is GPL-2.0**, so its source cannot be copied into an MPL-2.0 tree.
- **libgit2 is GPL-2.0 with a linking exception.** The exception addresses
  linking, not copying source in.
- **`gitoxide` (`gix-*`) is MIT OR Apache-2.0**, so copying from it is
  permitted with attribution. That makes it a licence-compatible source; the
  earlier claim that it is the *only* compatible route was an overstatement, and
  nothing here establishes a blanket conclusion about every git-adjacent
  implementation.

**Object format, which constrains reuse regardless of licence.** An earlier
draft said `gix-hash::ObjectId` is SHA-1 with SHA-256 planned. That is wrong:
`gix-hash` 0.25.1 exposes **both `Sha1` and `Sha256`**, feature-gated. The
limitation is narrower and different — BLAKE3 is not among its object kinds, and
sharing SHA-256's 32-byte width does not make it substitutable, because an
object format carries the algorithm in its own identity and in the embedded
references between objects (§2.5). So under §6.1's BLAKE3 decision gix's object,
ref and pack plumbing is unusable for a *format* reason, not a licence one, and
not for want of a 256-bit hash.

**Position, to be written into `07-storage.md`:**

- Reuse git's **designs**, which are not themselves copyrightable expression:
  the loose-object plus packfile two-tier store, ref updates via lockfiles, the
  reflog, the index/staging model, compare-and-swap against an expected parent.
- Treat `gix-*` as a genuine option for hash-agnostic pieces, evaluated per
  crate and attributed where used.
- **Do not copy from git or libgit2**, on the licence ground above.

§6.1 landed on BLAKE3, so the format objection stands and this position holds.
Had it landed on SHA-256 the objection would have disappeared, and this section
would have needed revisiting rather than reapplying.

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

**The Rust diff engine is already done.** It landed under
[#8042](https://github.com/LTplus-AG/ifc-lite/issues/8042) while this document
was in draft, as ten stacked PRs: the byte-exact fingerprint foundation
(#8043), keyed comparison (#8063), content matching (#8064), split and merge
detection (#8068), successor matching (#8069), identity claims and lineage
(#8070), the sidecar wire formats and the composed engine (#8071), independent
WASM bindings and adapters (#8081), UTF-16-preserving document serde (#8104),
and lossless typed fingerprint projections (#8105). `@ifc-lite/diff` now
depends on `@ifc-lite/wasm` for that staged backend.

So `03-diff.md` will document what shipped rather than proposing it, and the
GUID-agnostic identity of §2.2 builds on an engine whose behaviour is already
pinned by parity fixtures.

| # | PR | Status |
| --- | --- | --- |
| 1 | **This docs skeleton** (`index.md` + mkdocs nav) | done |
| 2 | Rust diff engine, ported byte-exact under #8042 | **done** (#8043 → #8105) |
| 3 | `01-concepts.md`, `02-graph-object-model.md` | this PR |
| 4 | `03-diff.md`, documenting the engine that landed in 2 | next |
| 5 | Graph node model in Rust: GUID-agnostic node identity, with the shipped content-match tiers as its reconciliation fallback | after 4; §6.1 answered |
| 6 | Authorship extraction across the four schemas | after 5 |
| 7 | Object store and refs: commit, branch, compare-and-swap on the head | after 5; needs §6.2 answered |
| 8 | The verb surface: `status`, `commit`, `branch`, `diff <a> <b>`, `log` | after 7 |
| 9 | `pull` / `push` against a remote | after 8 |
| 10 | Source-control view in the viewer | after 8 |

Two defects found while scoping this spec set were filed separately and are
both now closed: a viewer Compare scope gap that hid any change confined to a
geometry-less type object (#8040), and header-author stamping on the
layer-apply path contradicting the rule against fabricated attribution
(#8041).

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
