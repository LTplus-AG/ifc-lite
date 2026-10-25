# 02: Graph Object Model

Status: draft, for discussion. Part of the [ifc-git spec set](index.md).
Depends on the decision in index §6.1.

## 2.1 Four object kinds

git has four: blob, tree, commit, tag. ifc-git has the same four, with one
substitution — a blob holds *delivered bytes*, and the thing a tree points at is
a **node**, not a blob.

| Object | Immutable content | Addressed by |
| --- | --- | --- |
| **Blob** | The delivered file's bytes, verbatim | digest of those bytes |
| **Node** | One vertex of the IFC graph: its own fields plus references to its children's addresses | digest of its canonical encoding |
| **Tree** | The manifest of one version: `key → node address`, chunked | digest of the manifest |
| **Commit** | Tree, parents, author, committer, intent, diff summary | digest of the record |

A blob is kept so a version can be reproduced byte-for-byte and so a signature
over the original delivery remains checkable. It is **not** what versions are
compared by; index §1.5 and §2.6 below give the reason.

## 2.2 Nodes: what is a node and what is a field

A node exists where a change should be **attributable on its own**. Everything
else is a field of its owner.

| Node kind | Why it is its own node |
| --- | --- |
| `element` | The thing a person points at. Composite: a fold of its component addresses. |
| `property-set` | Shared by many occurrences through `IfcRelDefinesByProperties`. One edit must be one change, not N. |
| `quantity-set` | Same argument. |
| `relationship` | Its identity is its endpoints, so it changes when they do and should say so once. |
| `geometry` | Large, independently reusable, and already hashed by the geometry pass. |
| `material` / `classification` | Resolved name bags, shared across elements. |

Fields, by contrast: `Name`, `Description`, `ObjectType`, `PredefinedType`,
`Tag`, the IFC class. These have no identity apart from their owner, and they
are folded into the owner's `attr:core` component.

This split is already specified. `packages/provenance/SPEC.md` §3.2 defines
exactly these composites, and its `element` encoding is a fold of per-component
child hashes **sorted by `componentKey`**, over the vocabulary in
`packages/diff/src/fingerprint.ts`. ifc-git does not invent the model; it
inherits it and fixes one thing (§2.4).

## 2.3 Component keys

The component key is the unit a change is reported against, and the unit a
conflict is detected at.

```
attr:core              direct attributes plus the IFC class
pset:<Name>            one per property set
qset:<Name>            one per quantity set
type-assignment        assigned types, by name and class
material               resolved material names
classification         resolved classification references
placement              the object placement
geometry:<tier>        tessellated output, per tier
child:<name>           a relation slot
```

Shared with `@ifc-lite/diff` (which emits the first six) and `@ifc-lite/merge`
(which adds the last three). One vocabulary, three consumers, no translation
layer — which is why ifc-git keeps the spelling rather than improving it.

## 2.4 Content addressing, and the one correction v0 needs

A node's address is the digest of its canonical encoding, which includes the
**addresses of its children**, not their contents. That is the Merkle rule, and
it gives three properties for free:

- **Unchanged is cheap to prove.** Equal address, equal subtree. No walk.
- **Change localises.** Editing one property changes that `property-set` node's
  address, which changes the owning `element`'s address because the element
  encodes the child address — and changes nothing else. The element's
  `changedComponents` names `pset:<Name>` and the diff stops there.
- **Identical content deduplicates.** Two elements with the same properties
  share one `property-set` node.

### The correction

**v0's `element` encoding hashes the entity's `key`** — §3.2: "header, `key`
(string — the entity's stable identity, typically `GlobalId`), `ifcType`
(string), `componentCount` (u32), then components sorted by `componentKey`".

So a from-scratch re-export that regenerates every `GlobalId` changes every
element address, and therefore the tree, and therefore the commit. That is the
exact case index §2.2 exists to make invisible, so as written v0 cannot deliver
it. Non-element kinds are already content-only and need nothing.

**Proposal: the node address is content-only, and the key lives in the tree.**

```
node    = digest( ifcType, components sorted by componentKey )     no key
tree    = { key -> node address, ... }                             keys here
```

This is precisely git's arrangement: a blob is content, a tree maps names to
blobs, and two identical files share one blob. The consequences are the ones
wanted:

- A re-GUID rewrites tree **keys** and leaves every node address alone. The
  version reads as unchanged in content, with a key remapping — the rename case
  `@ifc-lite/diff`'s shipped content-matching tiers already resolve.
  `identityMapFromContentMatches` records that remapping **only where the match
  is one-to-one and of a claimable kind** (`renamed`, `moved`, `reshaped`,
  `respecified`). `ambiguous`, `duplicated` and `deduplicated` emit nothing, and
  deliberately so: those are the engine saying it could not tell, and a claim
  derived from an abstention is a fabrication. So where two coincident
  duplicates both change key, the matcher abstains rather than guessing which
  new key belongs to which old one — see the last bullet of §2.8, where the same
  case is measured. The new keys do change the tree's own address; §2.7 says why
  that is still not a commit.
- Two genuinely distinct elements with byte-identical content collapse to one
  node address. That is correct — it is what deduplication means — and nothing
  is lost at the tree layer, because the tree still carries both keys pointing
  at it. Cardinality and identity live in the tree, where they belong. What that
  costs a `relationship` node, whose endpoints are node addresses rather than
  keys, is an open point in §2.8.
- `GlobalId` becomes **evidence used for pairing**, never identity. It makes
  pairing fast when it is stable and costs nothing when it is not.

Per v0's own change policy this lands as a new `node-hash-v1.md` with a new
magic byte and a major bump of `@ifc-lite/provenance`, leaving `NHV0`, its
golden vectors and the determinism-certificate work untouched. See index §6.1
for the decision still open: author v1 there, or define the encoding in
`rust/git`.

## 2.5 Canonical encoding

Rules, inherited from v0 §3 because they are already right and already pinned:

- **A fixed header per node**: magic, kind tag, format version. A new magic byte
  is how a v1 announces itself.
- **Sets are sorted, lists are not.** Where a field is semantically a set — a
  property set's members, a relationship role's targets — it is sorted so input
  order cannot reach the hash. Where order is content, it is preserved.
- **Sort by code unit, never by locale.** A collation differs between machines;
  `localeCompare` without an explicit locale uses the runtime default, and the
  orders genuinely disagree. The hash exists to be identical across machines.
- **Counts are encoded before members**, so a truncated stream cannot be
  mistaken for a shorter valid one.
- **No non-finite numbers reach the encoder.** `NaN` and the infinities become
  distinct string tokens first, because JSON maps them to `null` — the same
  token an absent value produces, and an equal hash is treated as content
  identity downstream.
- **IFC names are exact EXPRESS PascalCase** (`IfcWallStandardCase`), never
  normalised.

The Rust implementation of the string and number rules already exists and is
pinned byte-for-byte against the TypeScript engine, in `rust/diff`
(`js_json.rs`, `utf16.rs`, `fingerprint.rs`, landed under #8043). A v1 encoder
reuses it rather than restating it; the UTF-16 reading in particular was costly
to get right and should not be re-derived.

## 2.6 Trees

A tree is the version's manifest: `key → node address`, plus the element's IFC
class so a listing needs no node fetch.

**Chunked, because a delivery is large.** A real model is on the order of
hundreds of thousands of entities and tens of thousands of objects. A monolithic
manifest would be rewritten in full for a two-element change. So the manifest is
split into chunks, each content-addressed, and a commit's tree is the list of
chunk addresses — unchanged chunks are reused by reference between commits.

Chunk boundaries must be **content-derived**, not positional. With fixed-size
chunks, inserting one element shifts every subsequent entry and invalidates
every chunk after the insertion point; with boundaries chosen from the content
(a rolling hash over sorted keys), an insertion disturbs one chunk. This is the
packfile problem git already solved, and the design to reuse — not the code,
which is GPL-2.0 (index §6.2).

## 2.7 Commits

```
commit = digest(
  tree address,
  parents[]          parents[0] is the mainline parent; empty for the first
  author             responsible for the content, resolved from the file (04)
  committer          who or what performed the upload
  intent             why this version exists
  diff summary       counts and changed component keys against parents[0]
  software release   what computed it
)
```

Immutable, so anything derived from a commit can be cached by its address with
no expiry.

Two rules:

- **No empty commits, and the test is the diff rather than the tree address.**
  An unchanged re-export produces no commit. A re-GUIDed re-export is the case
  that makes the distinction load-bearing: its keys differ, so its tree address
  differs from its parent's, while the diff of node addresses is empty. Tree
  inequality is therefore not evidence of change — the diff is the only thing
  asked — so no commit is written and the ref does not move. The source revision
  is recorded as pointing at the existing commit, so a scheduled sync is
  idempotent without inventing history. git refuses empty commits by default;
  here it matters more, because an unchanged re-export is the *common* case.
- **Diff before writing the tree.** An earlier draft called the unreferenced
  tree and chunks "mostly free", on the grounds that an unchanged chunk
  deduplicates against the one already stored. That reasoning does not hold for
  the case this rule exists for: in a full re-GUID **every key changes**, so
  every chunk's bytes change, and none of them deduplicates. Writing first would
  let each scheduled sync of an unchanged model accumulate a fresh orphaned tree
  and a full set of orphaned chunks while the ref never moves — unbounded growth
  driven by the most common event in the system.

  So the order is **not** an implementation detail: compute the diff first, and
  write the tree only once the diff is non-empty. `07-storage.md` carries the
  storage contract and must state a bound and a reclamation rule for orphans
  that arise another way (an interrupted write, a refused compare-and-swap),
  because append-only without a bound is a leak and not a guarantee.
- **Compare-and-swap on the ref.** A commit names the parent it expects. Two
  deliveries built on the same parent mean the second is refused and must be
  rebased. That is the whole of the concurrency control.

## 2.8 What this does not address

- **The digest.** Open in index §6.1.
- **Where the encoding lives** — `node-hash-v1.md` under
  `@ifc-lite/provenance`, or `rust/git`. Also index §6.1.
- **Storage layout.** Loose and packed tiers, on-disk format: `07-storage.md`
  (planned, index §5).
- **Geometry node granularity.** `geometry:<tier>` is a component key here, but
  whether a tier is one node or several, and how it relates to the geometry
  pass's existing hashes, needs the geometry pipeline's view and is deferred to
  `03-diff.md`.
- **Relationship endpoints under deduplication — resolved, with one stated
  limit.** A `relationship` node names its endpoints by node address, which is
  what keeps it content-only. A review raised the consequence: where §2.4
  collapses two distinct elements to one address, a relationship naming one
  names both. Measured in `rust/git/tests/dedup_boundary.rs`, the boundary is
  narrower than it reads, and cardinality survives:

    - Two occurrences differing **only in placement** do not deduplicate, so
      the ordinary case — two openings in one wall — has no ambiguity at all.
      Deduplication needs identity in *every* component, placement included.
    - What remains is genuinely coincident duplicates: two entities identical
      in everything a model records, which is a modelling defect rather than a
      representation worth preserving. Their relationships do collapse to one
      node.
    - **The tree still names both.** Four keys over two distinct nodes, exactly
      as two identical files in git are two tree entries pointing at one blob.
      Cardinality lives in the tree, which is the layer §2.4 claims it at.
    - The residual question — which of two indistinguishable coincident
      openings a given void targets — has no observable answer, because the two
      differ in nothing a model records.

  The limit worth writing down: **a consumer reconstructing from nodes alone,
  bypassing the tree, sees one occurrence where there are two.** Reconstruction
  goes through the tree, because that is where keys live, so this constrains
  implementations rather than the format. Keying endpoints by tree key would
  separate them, but it puts `GlobalId` back into the hash — which §2.4 exists
  to avoid — and is not worth paying for a case with no observable answer.

- **Authorship fields.** The `author` and `committer` shapes are
  `04-authorship.md`'s subject; this document only says the commit carries
  them.
