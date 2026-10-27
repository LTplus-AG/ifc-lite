# 01: Concepts and Glossary

Status: draft, for discussion. Part of the [ifc-git spec set](index.md).

## 1.1 The shape of the thing

git versions a **tree of text files**, and its unit of change is a line. ifc-git
versions an **IFC graph**, and its unit of change is a node. Almost every git
concept survives that substitution; a few do not, and §1.5 is about those,
because a concept that nearly maps is more dangerous than one that obviously
does not.

Three levels:

- An **organisation** is a project — the thing people mean when they say "the
  federated model".
- A **repository** is one model file stream: the versions of a single delivered
  model, over time. Its name is the file name with version markers, dates and
  extension stripped.
- A **commit** is one accepted version of that repository, computed from the
  **diff against its parent**.

## 1.2 Glossary

| Term | In ifc-git |
| --- | --- |
| **Organisation** | A project. Holds repositories and the responsibility interface that resolves authorship (04). |
| **Repository** | One model file stream. Has a kind (§1.4), a default branch, and optionally an upstream it forks from. |
| **Blob** | The raw delivered bytes, content-addressed. Stored once; see §1.5 for why a blob is *not* the version's identity. |
| **Node** | A vertex of the versioned graph: an element, a property set, a quantity set, a relationship, a geometry representation. Content-addressed over its own fields plus its children's addresses (02). |
| **Component key** | The slice of a node a change is attributed to — `attr:core`, `pset:<Name>`, `qset:<Name>`, `type-assignment`, `material`, `classification`, `placement`, `geometry:<tier>`, `child:<name>`. Shared vocabulary with `@ifc-lite/diff` and `@ifc-lite/merge`. |
| **Tree** | The commit's manifest: the node addresses that make up this version. Chunked, so an unchanged chunk is reused between commits. |
| **Commit** | An immutable accepted version: a tree, parents, an author, a committer, an intent, and a diff summary against `parents[0]`. |
| **Parents** | `parents[0]` is the mainline parent. Empty for the first commit. More than one means a merge commit, which only enriched repositories produce (§1.4). |
| **Ref** | A mutable named pointer at an immutable commit. Branches and tags are both refs; a tag is a ref that may not move. |
| **Branch** | A line of versions: `main`, `delivery/<source>-<version>`, `enrich/<script>`, `work/<person>/<topic>`. |
| **HEAD** | The commit a working tree was derived from, and the expected parent of the next commit on that branch. |
| **Index / staging** | The selection of pending changes, by `(node, component key)` — the same unit a change is reported at. In memory only (§1.5). |
| **Remote** | The document management system the repository syncs with, addressed by that system's own file identifier so a rename there keeps the repository. |
| **Author** | Who is responsible for the *content*, resolved from the file (04). Never assumed from whoever uploaded it. |
| **Committer** | Who or what performed the upload: a scheduled sync, an automation run, a colleague. |
| **Intent** | The commit message: why this version exists. |
| **Fork** | A repository that tracks another as upstream — a fabricator's detailing model against the design model it details. |
| **Federation commit** | An organisation-level commit pinning one commit per repository: the coordination round's state of the federated model. |

## 1.3 Change localisation

The rule that makes the rest work, stated once:

> **A change belongs to the node that carries it.** The owning object is
> *marked*, not blamed.

Change one property value inside one property set, and the change is a change to
**that property-set node**. The element that references it reports
`pset:<Name>` among its changed components and nothing more. The file is not the
unit; neither is the element.

Two consequences worth stating because they are the point rather than a side
effect:

- **A shared property set that changes once is one change.** IFC lets many
  occurrences share a property set through `IfcRelDefinesByProperties`. Treating
  the set as its own node makes that one node change plus N markers, instead of
  N independent element changes that a reviewer has to recognise as the same
  edit.
- **The conflict unit is `(node, component key)`.** Someone editing a wall's
  placement and an automation editing its `Pset_FireSafety` are not in conflict.
  This is the same granularity `@ifc-lite/merge` already resolves at, which is
  why the vocabulary is shared rather than reinvented.

## 1.4 Repository kinds

| Kind | Who writes it | Upstream | Reaches `main` by |
| --- | --- | --- | --- |
| **Design** | A discipline's authoring team, through the document management system | none | fast-forward per delivery |
| **Supplier** | A fabricator or subcontractor | the design repository it details (a fork) | proposal with a mandatory validation check |
| **Enriched** | An automation run: classifications, quantities, issue overlays | the repository it enriches | **rebase** onto each new base commit |
| **Partial** | A derived extract: one storey, zone or discipline view | the source repository | regenerated, read-only |
| **Federation** | Coordination, one per organisation | every repository it pins | a federation commit per coordination round |

The kind decides which operations are even meaningful. Design and supplier
repositories hold **authored** files, so they fast-forward and never
auto-merge. Enriched repositories hold **overlays**, so they rebase, and a
rebase there is a real operation rather than a history rewrite: re-run the
script against the new base, carry identities through the identity map, and
report overlay nodes whose base node was deleted or changed as conflicts.

## 1.5 What does not map onto git

### A blob is not the version's identity

In git, byte-identical content *is* the same version. In IFC it is not, in both
directions, and the second direction is the one that matters.

Re-exporting an unchanged model produces **different bytes**. The STEP header
carries a timestamp and the exporter's identity — `IfcSourceHeader` records
`timeStamp`, `preprocessorVersion` and `originatingSystem`, and ifc-lite's own
writer forces `preprocessorVersion` to the writing application
(`packages/export/src/step-header.ts`). Entity numbering is reassigned.
`GlobalId`s are regenerated by a from-scratch export. So a byte comparison
reports a total rewrite of a model nobody touched.

Hence: **the blob is stored, and the tree is compared.** The commit is computed
from the diff against its parent, which is also why an unchanged re-export
produces no commit at all rather than an empty one.

### Identity is content, not a path

git identifies a file by its path and infers a rename from similarity. IFC has
`GlobalId`, which looks like a stable identity and is not: it is stable while a
file is edited in place, and regenerated by a from-scratch re-export — and
`IfcTypeObject` is an `IfcRoot`, so types are re-GUIDed too.

So `GlobalId` is **evidence, not identity**. A node's address is its content
plus its children's addresses, and the key lives in the tree that points at it
— which makes a re-GUID a change of tree keys and no change of node addresses.
`@ifc-lite/diff` already treats a type assignment by name and class rather than
by the type's `GlobalId`, for exactly this reason; ifc-git generalises that
decision rather than introducing it.

A re-GUID does still change the **tree**, because the keys are part of the
manifest the tree is addressed by. That is not in tension with the paragraph
above, because **the emptiness test is the diff, not the tree address**: the
diff of node addresses is empty, so no commit is written and no ref moves
([02 §2.7](02-graph-object-model.md#27-commits)).

Note that the frozen node-hash v0 does **not** yet do this: its `element`
encoding hashes the key. Getting content-only addressing is the one substantive
change a v1 needs, and [02 §2.4](02-graph-object-model.md#24-content-addressing-and-the-one-correction-v0-needs)
sets out why and how.

### Two authored files are never merged automatically

git merges text hunks and reports a conflict when they overlap. Two authored IFC
deliveries have no shared line structure to merge: they come from different
authoring sessions, often different tools, and a structurally mergeable pair can
be semantically incompatible — a wall moved in one and a door re-hosted in that
wall in the other.

So **merge between authored repositories is advisory**: reported node by node
(ours, theirs, both changed), never resolved by writing a merged file. The
operation that *is* real is rebasing an overlay onto a new base, which has a
single source of truth to re-derive from.

### The index stages `(node, component key)` pairs, and does not persist

git's index stages file content and survives a restart. ifc-git stages
**`(node, component key)` pairs** — the same unit a change is reported at and a
conflict is detected at (§1.3) — and deliberately does not persist: the working
tree is the live edit overlay, which today is in-memory and is cleared on
session reset. Staging inherits that. A durable working tree is a separate
decision, out of scope for v1 (index §9).

Staging the **element** would be the wrong unit rather than merely a coarser
one. A property set shared by N occurrences is one node, so an element-level
stage either drags in the other N−1 occurrences' view of the same edit or splits
one node change across N stages, and neither is what the author chose. Selecting
an element in the UI is therefore shorthand that **expands** to exactly the pairs
that element marks; a shared node can be staged on its own, from any one of its
referents, and it is staged once.

### Line-level anything

There is no line. `diff <a> <b>` answers in nodes and component keys. A textual
diff of two STEP files is a different tool for a different question — useful for
debugging an exporter, not for versioning a design.

## 1.6 What does map, and should keep its name

Worth stating explicitly, because the temptation is to invent vocabulary:

- **Content addressing, and an append-only object store.** A node, a tree and a
  commit are all immutable and named by their digest.
- **Compare-and-swap on a ref.** A commit names the parent it expects; two
  deliveries built on the same parent mean the second is refused and must be
  rebased. This is the whole of the concurrency control, as in git.
- **An append-only history DAG.** Any version is reproducible from its ancestry.
- **Branches, tags, fork and upstream.** Unchanged in meaning.
- **`status`, `commit`, `log`, `branch`, `diff`, `revert`.** Same questions, new
  unit. To be specified in `05-operations.md` (planned, index §5).

The vocabulary carries because the *workflow* carries. Someone who has reviewed
a pull request knows what a delivery proposal is; the cost of teaching a new
word is paid for nothing.

## 1.7 Relationship to the two neighbouring models

Named here so the glossary is unambiguous, and argued in full in index §4 and,
once written, `09-relationship-to-layer-prs.md` (planned, index §5).

- **Layer PRs** (`docs/architecture/layer-prs/`) versions edits authored *inside*
  ifc-lite as IFCX overlay deltas. Its unit is an opinion in a layer; its
  identity is a layer's content address. ifc-git's enriched repositories are the
  same shape, and the two meet at the component-key vocabulary.
- **Commit history** (`docs/architecture/commit-history/`, on a branch) reads
  *file revisions* from a document management system that already has them.
  ifc-git computes versions that nothing else has computed.

ifc-git is independent of both by design, and supersedes `@ifc-lite/merge` once
mature — which, under the anti-cruft rule, means deleting that path in the same
change rather than running two version-control stacks side by side.
