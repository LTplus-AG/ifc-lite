<!-- SPDX-License-Identifier: MPL-2.0 -->
# Unit 2 private backing and views

This is the finite unit 2 source candidate following frozen `be54e20ef9`.
Only `source_resources/mod.rs`'s `cfg(test)` declaration reaches these modules.
No parser, decoder, production cache, SourceBundle, consumer, public API or
feature/toolchain selection is switched. All builds, tests, Clippy, consumer,
performance and actual-account/pool execution for this candidate are **UNRUN**.
Parent source review and assembled validation remain required.

The authoritative original R3 contract was read in the Global-proof owner's
checkout, without overlays. Its SHA256 is
`34ee5695c015c302ae250f13a6fcabb0b67ecd87021bf863de0f38768d75e25c`.
The selected owner migration plan and R4 carry-forward also apply. Their earlier
results and the parent's earlier builds do not qualify these new owners.

## Dependency and assembly

The only dependency imported here is a separate ten-line checkpoint
`cdabb91401`: the exact two `cfg(test)` `same_storage_domain` methods frozen in
`f1689d65064ce333e4277bc6a6adc866221644b2`. One forwards from ResourceAllocator;
the other compares `std::ptr::eq` on the retained AccountedArc GateInner payloads.
They perform no stop check, charge, admission or execution authorization. Different
gates refuse composition even for the same source/account. Parent root
`06209aac5d` already includes the dependency. Apply only the unit 2 commit there,
not this dependency checkpoint or the older full allocator/gate files. Independent
assembled source review must include the two helper hunks. No unfrozen overlay or
Global-proof/witness code is imported. The parent's sequential borrow-drop repair
is not copied here; this patch does not touch those witness files.

## Representation and escape boundary

`AttributeOwner::Raw` remains exactly an Arc of the existing raw DTO vector.
`RawAttributeValue` is a private import spelling for that existing DTO, not a
new parser model or a tracked node. Future canonical collector Raw output must
keep its existing DTO/tree/layout/allocation semantics. Generic Global owned
nodes are manual authoring/test controls only; they are not a replacement Raw
parser or a promised permanent second production representation. Remove orphaned
controls when migration supplies their real consumers.

Owned nodes are a distinct, closed representation: inline scalars, shared UTF-8
text, shared immutable lists and shared typed payloads. Text contains an
allocator-bearing byte Box; list backing contains an allocator-bearing Vec;
typed payloads hold the immediate node and type-name text. SharedEntity owns
original id/type and AttributeOwner. All shared tracked headers/payloads use
standard Arc/Weak with the same allocator. No raw String/DTO/Global Vec is
permitted inside tracked backing. The private Stored set limits container and
Arc payloads to internal nonpanicking scalar/owner types. Raw DTO roots are
refused by tracked entity construction; no byte equality can grant authority.

AttributeRef/AttributeListRef borrow either DTO storage or owned storage without
allocating, exposing mutable backing, or manufacturing a tracked DTO reference.
They preserve immediate list/reference behavior, typed wrapper visibility,
raw binary hex, signed zero, integral/range checks and LOGICAL semantics.
Typed unwrapping is iterative. No grammar, text normalization or STEP escape
parser is implemented here. Owned subtree sharing copies a scalar or shares its
actual text/list/typed backing. Raw borrowed subtrees deliberately return no
`share_owned` result; explicit fallible Raw copying is a later canonical copier
obligation, never an implicit deep conversion in unit 2. Raw root Clone/Weak
sharing retains the original DTO allocation without copying it.

Clone is implemented only for sharing handles/immutable nodes. Buffers and
caches have no Clone, DerefMut, owning iterator, backing extraction or arbitrary
mutation closure. No new_cyclic, make_mut, infallible growth, into_boxed_slice,
custom hash/refcount, pointer registry, per-block permit or TLS authority exists.
Cache backing is the pinned hashbrown 0.15.5, u32 keys and FxBuildHasher. Its only
insert path handles replacement first, reserves fallibly, then uses the inspected
pre-reserved insertion path. This does not switch the current raw FxHashMap cache.

## Charges, failures and cleanup

Each actual Arc allocation (including inline payload and standard control block),
Vec capacity block and text Box block is independently allocated/deallocated by
its retained A. No guessed inline charge is added on top. Raw Global allocations
are explicitly Raw, not billed to a tracked account. The account, original owner,
epoch and baseline source backing retain their existing declarations; this unit
makes no new metadata coverage claim and introduces no quota.

Every fallible construction or growth validates current operation independently
of domain compatibility, including replacement/spare-capacity/ZST paths. Composite
constructors check strict Gate identity before mutation. Consuming errors retain
the donor; foreign rejection does not poison the compatible gate. Explicit copy
charges precede materialization. Standard allocator grow accounting keeps its
existing full old/new overlap and cumulative work/copy policy.

To recover donors on Arc admission failure, Shared uses the pinned nightly's
`Arc::try_new_uninit_in`, unique `Arc::get_mut`, initialization and `assume_init`.
Static inspection: alloc/src/sync.rs lines 1023 and 1439 in the configured
nightly-2025-11-15 rust-src. The former delegates the standard Arc layout to A;
the latter changes initialization state without allocating. There is no raw Arc
header construction, user callback or fallible step after writing the payload.
Text's Box initializes only fixed borrowed UTF-8 bytes, so there is no fallible
per-element callback or partially initialized nontrivial payload to abandon.
Nested candidate prefix cleanup uses ordinary Vec/node drop glue.

Clear/remove/take/replace methods explicitly named `for_cleanup` drop or move
backing, retain empty capacity, allocate nothing and require no live work. They
do not grant later allocation rights. Last strong drops nested storage; last
Weak frees the actual standard Arc allocation before refund and keeps the original
allocator/gate/account dependency until that point. Core tests exercise actual
fixture-account and gate retention, including cross-thread final Weak release.
An actual geometry Pool witness belongs to parent/Global-proof integration and
is not claimed by these core fixtures. There is no stable-default-Rust versus
nightly rollout promise; the current pinned scope is unchanged and new consumers
must be compiled when their migration lands.

## Finite validation source

Direct tests manually construct owned nodes and compare existing DTO reads.
They cover nested layout events, child survival, Weak-only retention, exhausted
and stopped/expired sharing, explicit constructor and growth refusal, donor
recovery, initialized-prefix cleanup, same-source/account different-gate refusal,
cache replacement/tombstones/capacity cleanup, ZSTs and original-stop precedence.
They do not assert source strings or test mock return values. These tests have
not run; source review is not execution evidence. See qualification.json for
source hashes and the exact UNRUN scope.
