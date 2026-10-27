# 02: Graph Object Model

Status: draft, for discussion. Part of the [ifc-git spec set](index.md).
Index §6.1 records the digest as decided (BLAKE3) and the encoding's home as
proposed: specified and implemented in `rust/git`.

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
  new key belongs to which old one — see §2.8, where the same case is measured.
  The new keys do change the tree's own address; §2.7 says why that is still not
  a commit, and under what condition that claim holds.
- Two genuinely distinct elements with byte-identical content collapse to one
  node address. That is correct — it is what deduplication means — and nothing
  is lost at the tree layer, because the tree still carries both keys pointing
  at it. Entry cardinality lives in the tree, where it belongs. What that costs
  a `relationship` node, whose endpoints are node addresses rather than keys, is
  **open** — §2.8 records what has been measured, what an earlier draft got
  wrong, and the equivalence policy still to be decided.
- `GlobalId` becomes **evidence used for pairing**, never identity. It makes
  pairing fast when it is stable and costs nothing when it is not.

This is not v0 with a different digest — the element node carries no `key` at
all — so it is not authored as a `node-hash-v1.md` under
`@ifc-lite/provenance`. The proposal is that `rust/git` owns the encoding, under
its own magic bytes and version byte, and `NHV0` stays frozen with its golden
vectors and the determinism-certificate work it was built for. Index §6.1 records
the digest decision, the open proposal for the encoding's home, and the argument
that changed on the way to them.

## 2.5 Canonical encoding

**Retained from v0 §3 exactly**, because these rules are already right and
already pinned by golden vectors:

- **A fixed header per node**: 4-byte ASCII magic, 1-byte kind tag, 1-byte
  format version. A new magic is how a successor announces itself, which is what
  v0's own change policy requires.
- **Little-endian integers**, and every **count precedes the members it
  introduces**, so a truncated stream cannot be mistaken for a shorter valid one.
- **Strings are NFC-normalized by the hasher**, then written as a `u32`
  length prefix and UTF-8 bytes.
- **Sets are sorted, sequences are not.** Where a field is semantically a set —
  a property set's members, a relationship role's targets — it is sorted so
  input order cannot reach the hash. Where order is content, it is preserved.
- **Sorting compares the same NFC-normalized UTF-8 bytes the encoder writes.**
  Not the raw spelling, and never a locale collation. v0 states the reason, and
  it is not a nicety: sorting raw while encoding normalized lets the producer's
  *spelling* pick the order. `Pset_Béton` with a precomposed `é` and with a
  decomposed one is one string canonically and two byte sequences rawly, so
  against a neighbour like `Pset_Bzton` the two sort opposite ways — one
  canonical input, two hashes. v0 calls that worse than a collision for a
  verifier, because recompute-and-compare then fails on honest data.
- **IFC names are exact EXPRESS PascalCase** (`IfcWallStandardCase`), never
  normalised as identifiers. (Unicode normalization above is a byte-level
  canonicalisation of the string; it does not rewrite an EXPRESS name.)

### Where this departs from v0, and what that costs

An earlier draft of this document claimed to inherit v0's rules while
describing UTF-16 code-unit ordering. That was wrong twice over: v0 sorts
normalized UTF-8 bytes, and the two orders **disagree above the BMP** (a
surrogate pair's code units sort below `U+E000`, its UTF-8 bytes above). The
UTF-16 contract belongs to `rust/diff`, which is a different compatibility
format — it exists to reproduce V8's `JSON.stringify` byte for byte and has no
bearing here. `rust/git` now follows v0.

One departure remains, and it is deliberate rather than inherited:

- **A child-hash reference is encoded as raw digest bytes, not as v0's tagged
  hash string.** v0 embeds `"sha256:…"` so a parent need not know which
  algorithm produced a child's hash. With one algorithm throughout — BLAKE3,
  index §6.1 — that
  indirection buys nothing and costs ~38 bytes per reference on an object whose
  whole content is references. **This is a v1 change and needs its own magic,
  version and golden vectors** — it is not compatible with `NHV0`, and nothing
  here should be read as claiming otherwise.

The string and number rules have a Rust implementation already pinned
byte-for-byte against the TypeScript engine, in `rust/diff` (`js_json.rs`,
`utf16.rs`, `fingerprint.rs`, landed under #8043). A v1 encoder reuses what
applies and must *not* reuse the UTF-16 ordering, for the reason above.

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
  differs from its parent's, while the diff is empty. The diff is taken over the
  tree's `key → node` **entries**, not over the set of distinct node addresses —
  multiplicity is part of it. Deleting one of two coincident duplicates leaves
  the distinct-address set unchanged while genuinely changing the model, so a
  set-based test would read that deletion as nothing
  (`rust/git/tests/dedup_boundary.rs` pins the case). Tree
  inequality is therefore not evidence of change — the diff is the only thing
  asked — so no commit is written and the ref does not move. The source revision
  is recorded as pointing at the existing commit, so a scheduled sync is
  idempotent without inventing history. git refuses empty commits by default;
  here it matters more, because an unchanged re-export is the *common* case.

  **This rule is conditional on §2.8's open equivalence policy, and must not be
  read as unconditional.** Review supplied the counter-case: retarget a void
  from occurrence A to its coincident twin B, and both occurrences keep their
  keys and their shared node address, the relationship node's endpoint set does
  not move, every tree entry is identical, and the diff is empty — so this rule
  as stated writes no commit for a model that changed. That is a real hole, not
  a tolerable edge: it is silent, and it is silent in the direction of losing
  history. Until §2.8's equivalence policy is decided, "empty diff ⇒ no commit"
  holds **only** for models containing no coincident duplicates, and an
  implementation must either detect that condition or refuse to claim
  idempotence. Whichever way §2.8 resolves, this rule has to be restated against
  it rather than inherited.
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

- **Storage layout.** Loose and packed tiers, on-disk format: `07-storage.md`
  (planned, index §5).
- **Geometry node granularity.** `geometry:<tier>` is a component key here, but
  whether a tier is one node or several, and how it relates to the geometry
  pass's existing hashes, needs the geometry pipeline's view and is deferred to
  `03-diff.md`.
- **Relationship endpoints under deduplication — OPEN. The equivalence policy
  is undecided, and an earlier draft of this bullet both overstated the
  resolution and rested on a false premise.**

  A `relationship` node names its endpoints by node address, which is what
  keeps it content-only. Review raised the consequence: where §2.4 collapses two
  distinct elements to one address, a relationship naming one names both.

  What the measurement does establish, in
  `rust/git/tests/dedup_boundary.rs` at
  [`bruadam/ifc-lite@65b5982b7`](https://github.com/bruadam/ifc-lite/commit/65b5982b77c0794df588734c59cdd22c8e950c58)
  — an external branch, not this docs change, so it is not reviewable from this
  PR:

    - Two occurrences differing **only in placement** do not deduplicate, so
      the ordinary case — two openings in one wall — has no ambiguity at all.
      Deduplication needs identity in *every* component, placement included.
    - What remains is genuinely coincident duplicates. Their relationships do
      collapse to one node.
    - **The tree still names both.** Four keys over two distinct nodes, exactly
      as two identical files in git are two tree entries pointing at one blob.
      Entry cardinality lives in the tree, which is the layer §2.4 claims it
      at. This preserves *how many* occurrences there are; it does not recover
      *which* of them a collapsed relationship named, and the two are not the
      same guarantee.

  **The correction.** An earlier draft said the residual question "has no
  observable answer, because the two differ in nothing a model records". That is
  wrong, and it mattered, because the whole justification for not paying for
  tree-key endpoints was built on it. Coincident duplicates have **distinct
  `GlobalId`s**, and the source relationships name one or the other. **The model
  does record the association.** It is this encoding — endpoints as node
  addresses — that discards it. The information is not absent from the source;
  it is dropped in projection, which is a different and more serious thing.

  **A consequence that reaches §2.7.** Retargeting a void from occurrence A to
  its coincident twin B changes the model and changes nothing this encoding can
  see: both occurrences keep their keys, both keep the same node address, the
  relationship node's endpoint set is unchanged, so every tree entry is
  identical and the diff is empty. Under §2.7's rule as first written, that
  edit produces **no commit at all**. §2.7 now states the rule conditionally
  for exactly this reason.

  **What stays, and what is open.** Node-address endpoints remain the current
  **proposal**, and the reason is unchanged: tree-key endpoints put `GlobalId`
  back inside the hash, which is what §2.4 exists to prevent. What is *not*
  settled is the equivalence policy — whether two coincident occurrences are
  one node or must be separated, and if separated, by what that is not a
  `GlobalId`. A third option neither explored nor dismissed here is an
  occurrence discriminator derived from the relationship's own position rather
  than from the element's identity. This needs a decision and does not have one.

  The implementation limit is still worth writing down: **a consumer
  reconstructing from nodes alone, bypassing the tree, sees one occurrence where
  there are two.** Reconstruction goes through the tree, because that is where
  keys live.

- **Authorship fields.** The `author` and `committer` shapes are
  `04-authorship.md`'s subject; this document only says the commit carries
  them.
