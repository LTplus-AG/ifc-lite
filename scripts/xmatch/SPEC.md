# Content-matching validation fixture (#1891)

The standing instrument for **does content matching work**, as opposed to **do
its unit tests pass**.

Everything measured about the matcher before this existed was measured on models
the program itself mutated and then graded. This fixture is worth having only if
it can genuinely fail, so every section below is written as an answer to "how
would this check pass while the matcher is broken".

Run it:

```
pnpm fixtures                        # the corpus lives in tests/models/manifest.json
pnpm turbo build --filter=@ifc-lite/parser --filter=@ifc-lite/diff --filter=@ifc-lite/cli
node scripts/xmatch/run.mjs          # score against the pre-registered thresholds
node scripts/xmatch/run.mjs --self-test   # mutation-check the harness itself
```

Exit codes: `0` pass, `1` a threshold or a fixture guard failed, `2` the run
could not happen at all (missing fixture, missing wasm, unbuilt packages).

## What is under test

The shipped code, imported and not re-implemented:

| Layer | Source |
| --- | --- |
| data fingerprints | `buildFileFingerprints` — `packages/cli/dist/commands/diff-engine.js` |
| canonical hashing | `buildDataFingerprint` / `buildComponentFingerprints` — `@ifc-lite/diff` |
| geometry hash + world AABB + volume | `runGeometryPass` — `packages/cli/dist/commands/diff-geometry.js` (issue #4956), the same `ifc-lite diff --by-content --geometry` mesh pass; `geometryVolumeValues` where the mesh was proved closed |
| assembly (attach the geometry pass onto the data fingerprints) | `attachGeometryFingerprints` — `packages/cli/dist/commands/diff-geometry.js` |
| spatial container | `spatialContainerPath` — `@ifc-lite/parser`, the name path the successor stage's `position` profile keys on |
| the matcher | `diffModels(..., { scope: 'both', matchUnpairedByContent: true, detectSplitMerge: true, detectSuccessors: true })` |
| class families | `classFamilyResolver` — `packages/diff/dist/class-families.js`, the same table the two claim stages bucket by |

`fingerprints.mjs` supplies only the file-level orchestration (parse, call the
two adapters, resolve `spatialContainerPath`, optionally strip keys); the
fingerprint assembly itself — data hash, geometry pass, and attaching one onto
the other — is entirely the CLI's own `--geometry` code (issue #4956, superseding
the duplicate this file used to carry). The volume is kept only when finite
and positive — the wasm's `NaN` means "not proved closed", not zero — exactly
as `@ifc-lite/geometry`'s `geometryVolumeAt` resolves it; without it a split
claim can only ever reach `extent`.

## The answer key

A seeded mutation program (`mutate.mjs`) turns one real model from
`tests/models/` into a head revision and writes the true correspondence, keyed
by **source express id** — a channel the matcher never reads. The key is
produced by construction: the generator records what it did, rather than
deriving a correspondence from any hash or comparison.

The key carries two digests (issue #4989 review): `sourceSha256` is always
the PRISTINE file's digest — the bytes `sourcePath` names on disk, whether or
not anything in this run touched them — and `baseSha256` is the digest of the
text `run.mjs` actually fingerprints as "base". The two are byte-identical
for every model with no `merged` role; they diverge exactly when `merged`
produced a mutated base text (see below), and a reader comparing the key
against what was actually scored must use `baseSha256`.

The head is a from-scratch re-export of the kind content matching exists for:

* every `IfcRoot` gets a new GlobalId, and
* **every express id is permuted**, so base and head ids do not even coincide
  for untouched elements. Without that, an accidental identity channel would
  exist between the two files.

Declared mutations, applied to elements the geometry pass produced a mesh for:

| kind | what the generator does | expected `ContentMatchKind` |
| --- | --- | --- |
| `renamed` | nothing but the re-GUID | `renamed` |
| `moved` | clone the placement chain, translate by a known vector | `moved`, `distance` ≈ \|v\| |
| `moved` (group) | move EVERY member of one same-content group, each to a different place | `moved`, via the positional tier |
| `reshaped` | scale the depth of every extrusion the element owns outright by 1.15 | `reshaped` |
| `retriangulated` | resample every circular arc in the profile at 7.3° | `reshaped` or `moved`, **never** `renamed` |
| `duplicated` | clone the element into every relationship list it sits in | an unresolved `duplicated` group containing both |
| `deleted` | drop the element, prune it out of every list | nothing at all |
| `inserted` | a head-only clone under a new name, 5 m away | nothing at all |
| `respecified` | re-GUID plus ONE data edit — a property value in a pset the element owns outright, else its `Name` — and no geometry edit | `respecified`, tier `geometry-only`, **never** `renamed` |
| `thickened` | scale the SHORTER axis of the one extruded rectangle the element owns outright by 1.25, and rename | no content match; a `footprint` `SuccessorClaim` (old box nests in new, IoU 0.8) |
| `swapped` | point the element's owned body `IfcMappedItem` at a different `IfcRepresentationMap` used by another element of the same class (family as fallback), and rename | no content match; a `position` or `footprint` `SuccessorClaim` |
| `splitLength` | the owned extruded rectangle becomes two half-length products: a clone enrolled in every list, a private copy of the shape chain, both renamed | no content match, no successor; one `split` claim, `verified` when volumes were proved, else `extent` |
| `merged` | the INVERSE of `splitLength` (issue #4989): a detached rectangle owner is split into two half-length products IN THE BASE ONLY, and the single original product survives, renamed, in the HEAD | no content match, no successor; one `merge` claim, expected `verified` (containment + exact volume sum) |
| `insertedNearby` | on a `deleted` element: a head-only clone of the same class at 0.3x its size on every axis, INSIDE its box | nothing at all — a `SuccessorClaim` onto it is the negative control |

The four kinds after `inserted` and the second negative control are issue
#4955's: the harness now also exercises the split/merge stage and the
successor stage, both opt-in stages that run on what content matching left
unbound. A "rectangle" is either an `IfcRectangleProfileDef` or an
`IfcArbitraryClosedProfileDef` whose outer curve is four corners at right
angles, read into one model and written back in the profile's own spelling:
rvt01 has 2 of the former and several hundred of the latter, and a fixture
that only knew the named profile would have had no split population on two
of three models. Half-length pieces are re-centred in the profile's own 2D
frame, so no 3D placement is touched; the clone shares the (unedited)
`IfcLocalPlacement`.

`merged` (issue #4989) is built as the literal inverse of `splitLength`, not
merely something that scores like one. An EARLIER version of this role
picked two independently-real, "adjacent" rectangle owners and glued a new
rectangle over one of them — honest-*sounding*, but a generator defect a
review caught (2026-09-19): `mergeElementLength` extended the primary's
profile along one fixed axis without checking which side the donor sat on,
so most constructed pairs pointed away from their supposed partner and the
engine correctly refused to merge them — measured `byMerge` recall 0.125,
precision 0.5, both artefacts of the direction bug rather than a property of
the engine. That construction, `mergePairs`/`mergeElementLength`, is
deleted; there is exactly one construction now.

The base revision is normally fingerprinted straight off the real file on
disk (`fingerprintFile(modelPath, …)` in `run.mjs`), untouched by the
generator — which is exactly why a "pick two real neighbours" approach
seemed necessary. But nothing stops the generator from producing a SECOND,
separately-mutated base text for the one role that needs it: `mutate.mjs`
picks a detached rectangle owner (interleaved with `splitLength` against the
same candidate pool — see below), renames it in the live HEAD file
(`freshName('merged')`) and touches nothing else there, then
`merge-base-split.mjs`'s `splitBaseForMerge` re-parses the PRISTINE text
fresh and calls `splitElementLength` on it — the exact same call
`splitLength` makes on the head — producing two real half-length products in
that base-only file: the primary's own id (edited in place, own GlobalId
kept) and a new clone (own express id, a freshly minted GlobalId — this base
file never goes through `mutate.mjs`'s `reguidAll`, so `splitBaseForMerge`
mints the clone's itself, off a PRNG stream derived from the seed but never
`random`, so it draws nothing from the streams `swapped`'s donor choice is
already documented as immune to). `run.mjs` fingerprints that base text
instead of the pristine file whenever it differs. Both real base-side halves
then tile the HEAD survivor's UNEDITED, full-length shape EXACTLY — the
engine's verified merge case (containment plus an exact volume sum), the
same proof `splitLength` already gets to 100% `verified` — not a coincidence
of adjacency scanning.

The answer key records the pair as TWO `key.elements` rows — `{ base:
primaryId, kind: 'merged', head: [primaryId] }` and `{ base: cloneId, kind:
'merged', head: [primaryId] }` — rather than one row with an array `base`,
because every OTHER reader of `key.elements` (`score.mjs`, `guards.mjs`)
assumes `element.base` is a single id; `scoreMerges` (`score-claims.mjs`)
reconstructs `{ base: [primaryId, cloneId], head: [primaryId] }` by grouping
on the shared `head`. `splitLength` and `merged` INTERLEAVE their draw from
the same detached-rectangle-owner pool (`mutate-support.mjs`'s
`interleaveSplitAndMerge`) rather than one draining it before the other
starts — draining first was the OTHER thing the 2026-09-19 review caught:
duplex's whole 9-element pool went to `splitLength` + `insertedNearby`
before `merged` ever got a turn under the old ordering. Even interleaved,
duplex's pool has no room left for `merged` once `splitLength` (4) and
`insertedNearby`'s own rectangle draw (5) are satisfied, so its `plan`
explicitly zeroes `merged` (`run.mjs`) rather than stealing back
`insertedNearby`'s corpus-floor headroom; rvt01's 59-element pool alone
carries `merged`'s population floor (8 of 8 measured `verified`, 100%
recall/precision). Both real elements are enrolled in the survivor's
containment list by simple fact — the clone is `splitLength`'s own
`cloneElement`, inheriting the primary's real membership — so "the head
product spans both" needs no separate proof here.

Elements the key covers but never mutates geometrically — `IfcProject`,
storeys, types, groups — are `renamed`, and they are the population that can
only be matched on data.

The group move is the only construction that reaches the **positional** tier:
tier 1 sub-buckets each moved member into its own world-hash bucket, the 1:1
residue rule does not apply to an N:N leftover, and what remains is exactly the
mutual-nearest-neighbour problem tier 3 exists for. Without it that tier never
fires and the fixture would be reporting a score for a tier it never exercised.
The members are moved by *different* distances, because mutual nearest
neighbour abstains on ties by design and a tie here would be the fixture's
doing.

Each edit is *local* by construction, and this is where most of the fixture's
complexity lives. IFC shares nodes aggressively, so:

* `moved` CLONES the placement chain rather than editing a possibly-shared
  `IfcCartesianPoint`;
* `reshaped` and `retriangulated` refuse unless the element owns its
  `IfcProductDefinitionShape` outright and the solid or arc has no second
  *structural* referrer — presentation referrers (`IfcStyledItem`,
  `IfcPresentationLayerAssignment`) do not count as sharing, and treating them
  as such found zero reshapeable elements in the whole Duplex model on the
  first attempt;
* `retriangulated` only touches arcs inside a `'Body'` representation. An arc
  in an `Axis` or `FootPrint` representation is never meshed, so re-sampling it
  changes the file and nothing about the geometry — the calibration stratum
  caught exactly that on the first run, as five re-sampled elements matching at
  tier 1 with an unchanged hash;
* `deleted` / `duplicated` / `splitLength` / `merged` / `insertedNearby`
  refuse unless every reference to the element sits inside a list;
* `thickened`, `splitLength` and `merged` require ONE owned extruded
  rectangle, not several: thickening every layer of a multi-layer wall by
  1.25 produces overlapping layers whose union box is not the `V_old /
  V_new` the footprint profile is specified against; `merged` reuses
  `splitElementLength` itself (on the base-only file), so it inherits that
  same requirement and needs no compatibility test of its own — there is
  only one element involved, not a pair to match;
* `swapped` rewrites the one pointer from the element's own `IfcMappedItem`
  to a map, never the map (type geometry shared by every occurrence). The
  donor must be structurally different from the element's own map
  (`representationMapDigest`): ArchiCAD writes several byte-identical maps
  per window, and a swap onto one of those keeps the world geometry hash and
  is rightly paired as `respecified`, which the key would then call wrong.
  What the digest cannot see is a MIRROR of a symmetric shape — AC20's two
  window maps are exactly that — so `swapped` is 0 on AC20 with that reason;
* `respecified` excludes hosts as well as features, because finding F1 (a
  host's hash can move with statement order through the opening CSG) would
  otherwise score the engine against a key that promised an unchanged shape;
* `respecified` edits a property VALUE, never a name: a label gets a suffix,
  a number is scaled, a logical is flipped, and the property-name multiset
  the guards assert identical is untouched;
* and **no mutation ever touches a feature** (`IfcOpeningElement` and friends,
  the related side of `IfcRelVoidsElement` / `IfcRelProjectsElement`), because
  its geometry is subtracted from its host's — moving an opening reshapes the
  WALL, an element the key calls untouched. A host may be reshaped or
  re-sampled (only its own mesh changes) but not moved, deleted or duplicated.

An edit that leaked into a neighbour would corrupt rows of the key that claim to
be untouched, and the fixture would score the matcher against a key that is
simply wrong. The first run measured one such leak as a 6% `kindAgreement` loss
on `renamed`, with every disagreeing element a covering, a slab or a wall.

### The re-GUID trap

A re-GUID that rewrites "every 22-character quoted token" also renames
`Qto_WallBaseQuantities` and `SpaceTemperatureSummer` — both exactly 22
characters in the IFC base64 alphabet. That changes property *names*, moves
every data hash, and makes the matcher look broken when the fixture is. This has
bitten this workstream twice, so:

* the rewrite is anchored to **attribute 0 of statements whose type inherits
  from `IfcRoot`**, decided from the bundled schema registry
  (`getInheritanceChainAcrossSchemas`), never from what a value looks like;
* the whole file is read with a **string-aware scanner** (`step-file.mjs`),
  because a regex goes blind after the first `''` escape;
* express ids must be **unique**, because nothing downstream re-checks:
  `indexModel` does `byId.set(id, …)` so a repeat silently replaces the first
  statement, and `permuteIds` keys its map by id so both would be handed the
  same permuted id — a collision in the head revision that the answer key does
  not describe. Four further uniqueness properties (base ids in the key, head
  ids claimed by the key, and the express ids of each side's fingerprints) are
  asserted per pair for the same reason: they all held on the corpus already,
  and this is what stops that being luck;
* express ids are validated as **text before conversion**, because
  `Number.parseInt` is a lexer rather than a validator — it returns what it
  managed to read, so `12A` becomes 12 and `0x10` becomes 0, and a following
  `Number.isInteger` can never notice. A mis-read id is the worst failure this
  file has: the statement lands under a different id, the answer key points at
  an element that is not there, and the run still scores. Malformed spellings
  fail as SYNTAX (`+5`, `-3`, `# 5`); `0` and anything past the exact-integer
  ceiling fail as RANGE, with their own message;
* and the harness **asserts** that the multiset of property-set, quantity-set,
  property and quantity NAMES is byte-identical between the two revisions before
  it scores anything.

A fixture that shows nothing matched is a fixture bug until proven otherwise.
The guards that turn that into a named failure, all fatal for the pair:

1. property/quantity name multisets identical;
2. zero GlobalIds shared between the revisions;
3. zero fingerprint keys shared (otherwise the key-based pass would match them
   and the content pass would never see them);
4. the key covers exactly the fingerprinted base population;
5. every keyed head element was actually fingerprinted;
6. both revisions carry geometry hashes (otherwise the engine's capability
   abstention silently switches the geometry tiers off and every match reports
   `renamed`);
7. every keyed counterpart carries the same spatial container NAME path as
   its base — the re-GUID must not have touched a storey or space name — with
   one exception that is REPORTED rather than failed: a path containing `#`
   names an unnamed spatial node by its express id, which no re-export
   preserves (finding F4 below);
8. every `insertedNearby` element really sits inside the deleted element's
   box, checked against the geometry pass's own boxes. A control planted next
   door would pass vacuously.

## The three strata

**By tier** — `ContentMatch.tier`, reported by the engine itself
(`geometry-hash` / `residue-1-1` / `positional` / `unresolved`). It is read, not
inferred: the same `renamed`-with-equal-hashes record is reachable from two
different tiers, so an inferring harness would mislabel exactly the cases that
matter. Aggregate precision hides a tier that has stopped firing behind the
tiers that still do.

**By kind** — the mutation that was applied, including the unresolved groups.
Reported per kind: recall (fixed denominator), precision, and `kindAgreement` —
whether the engine's own verdict matches what was actually done.

**By geometry class** — `prismatic` / `curved` / `none`, decided from the
element's representation subgraph in the source file (does it reference an
`IfcCircle`, a B-spline, a swept disk, …).

Since issue #4955 there are three more, for the two claim stages:

**By successor** — `bySuccessor.footprint` (the `thickened` population) and
`bySuccessor.position` (the `swapped` population): keyed by the profile the
harness EXPECTS, like `byKind` is keyed by the mutation, so recall has a fixed
denominator per profile. Recall credits a claim with the right head at any
confidence; `kindAgreement` is whether the reported confidence was one the
harness accepts — only `footprint` for a thickened wall, either for a swapped
family, whose box may or may not still overlap heavily. `bySuccessorConfidence`
is the `byTier` analogue: precision per REPORTED profile, so a profile that
starts guessing shows even while the other carries the recall.

**By split** — `bySplit`: recall over the `splitLength` population, precision
over every `split` claim (a `merge` claim is scored separately, under
`byMerge` — see below — and counted only informationally here as
`mergeClaims`, so it can never inflate `bySplit`'s own claimed/precision
denominators), a claim correct only when its whole is a split base and its
piece SET is exactly that base's two heads. `kindAgreement` is the confidence:
`verified` expected when the whole and both pieces carry a proved volume,
`extent` otherwise — read off the fingerprints, not assumed.

**By merge** — `byMerge` (issue #4989), the mirror image: recall over the
`merged` population (pairs, not rows — `score.mjs`'s corpus-population sum
uses `byMerge.population` rather than the raw `key.elements` count for
exactly this reason), precision over every `merge` claim, a claim correct
only when its whole is a `merged` head and its piece SET is exactly that
head's two real bases `{a, b}`. A `split` claim is counted only
informationally (`splitClaims`). Because the construction is the engine's
own verified-merge case (containment plus an exact volume sum — see the
`merged` row above), measured recall/precision/kindAgreement on rvt01 (the
only populated pair; duplex's pool is spoken for) are 8/8/8/8 — all
`verified`, same as `bySplit`.

Two more negative controls with a zero target: `falseSuccessors.insertedNearby`
(a claim onto the small element planted inside a deleted element's box) and
`falseSuccessors.neighbourSuccessor` (any other successor claim whose head is
not the base's true counterpart, including every claim on a `deleted` base).
And `respecifiedControl.reportedRenamed`: a `respecified` pair reported as
`renamed` would mean the data hash called two different payloads equal. This stratum is not optional. The
geometry hash is a **world-space quantized triangle multiset**, so a producer
that re-samples a curve emits different triangles for the same nominal surface
and cannot match at tier 1. Aggregate-only reporting is exactly how that hides
inside the prismatic mass. `none` is separate because a geometry-free object can
only ever be matched on data, and lumping it in with `prismatic` would let the
data tier hide inside the geometry tier's numbers.

## The calibration stratum that must score imperfectly

`retriangulated` elements are the same nominal shape sampled differently. The
triangle-multiset hash *provably* cannot pair them at tier 1 — not "probably",
by construction — so the harness **fails if any of them is reported with
`tier: 'geometry-hash'`, or with `kind: 'renamed'`**. A harness that can no
longer tell "matched" from "should have missed" is broken, and this is what
detects that.

They are expected to be recovered by the lower tiers (the data hash is
untouched, so the pair still shares a bucket), and that recovery rate has its
own floor. So the stratum fails in both directions: silence means the residue
tiers stopped working, a tier-1 match means the geometry hash stopped
discriminating.

## Why this cannot quietly stop failing

* **Fixed denominator.** Recall is over every keyed element with a counterpart,
  whether or not the matcher mentioned it.
* **`ambiguous` is an abstention.** Neither a hit nor a false pair — the engine's
  no-guessing contract is honoured rather than punished. Abstentions lower
  recall and leave precision alone, and are reported as their own number.
* **Negative controls are hard failures.** Deleted base elements and inserted
  head elements have no counterpart; pairing one is a wrong claim of identity,
  not a rounding error. Ceiling: zero.
* **Anti-vacuity floors.** The corpus clauses require each mutation to be
  applied a minimum number of times and each tier to fire a minimum number of
  times. A mutation that silently stopped being applied would otherwise show up
  as a *green* run over a smaller exam.
* **Pre-registered thresholds, kept even after they are missed.** See the next
  section — the gating floor and the pre-registered target are two different
  numbers and both are in `thresholds.json`.
* **The harness is mutation-checked, seven ways.** `--self-test` swaps in an
  always-match matcher, an always-abstain matcher and an over-eager one, and
  asserts the fixture rejects all three. Four more target the claim strata
  and each must be rejected by the clause family it was written against, not
  merely by something: `overlap-successor` (every touching box pair is a
  successor; must trip `falseSuccessors.*`), `rotated-claims` (the real claims
  with their partners shuffled one step; must trip a claim precision floor or
  `neighbourSuccessor`), `respecified-as-renamed` (the geometry-only verdicts
  relabelled tier-1 `renamed`; must trip `byKind.respecified.kindAgreement`
  or the `reportedRenamed` ceiling) and `silent-claims` (no claims at all;
  must trip a claim recall floor). A claim mutant is skipped on a pair whose
  key expects no claim — on AC20 the claim floors are skipped, so a mutant
  there could only survive vacuously — and every mutant must have been
  applied and rejected on at least one pair. If any survives, the harness
  proves nothing and the run fails.

## Floors versus targets

Two numbers per stratum, because they answer different questions.

**The gating floor** is a ratchet against *regression*: the measured baseline
minus a 0.02 margin. It is what turns the lane red. Green means "no worse than
the last blessed measurement" — it is **not** a claim that the number is good.

**The pre-registered target** is what was written down in commit `79604caa`,
before the harness had produced a single number. It never gates, it is never
edited to match a result, and any stratum below it is printed on every run as
`BELOW PRE-REGISTERED TARGET`. Two lines printed after the first run, and the
claim stages added their own (see "Second run", findings F4-F6). That is a
standing debt, deliberately impossible to lose track of:

| stratum | floor | measured | target |
| --- | --- | --- | --- |
| `byKind.renamed.recall` | 0.777 | 0.798 | **0.9** |
| `byKind.renamed.kindAgreement` | 0.924 | 0.945 | **0.98** |

There were three. `byClass.none.recall` met its target when issue #2021 put
`Tag` into the data fingerprint for type objects — 0.468 to **1.000** on Duplex,
0.680 to 0.880 on AC20, 0.718 to 0.768 on rvt01, precision 1 throughout — and
its gap line disappeared on its own rather than being deleted. Its floor
ratcheted 0.448 to 0.748 in the same commit. See finding F2.

Why a ratchet rather than leaving the lane red on the pre-registered numbers:
a permanently red required check trains everyone to ignore a red X, which is
the exact failure this fixture exists to prevent. And why not simply make the
lane non-blocking: a lane nobody must fix is a lane nobody reads. The ratchet
keeps the check live and keeps the shortfall visible.

**The margin is derived, not chosen.** The run is deterministic — same seed,
same wasm, byte-identical scorecard across runs — so there is no sampling noise
to absorb. What does move is finding F1: an unrelated change to the GlobalId
generator shifted the PRNG stream, hence the express-id permutation, hence the
CSG accumulation order, and moved `byKind.renamed.kindAgreement` by 0.005. The
margin is 4x that measured swing. It still bites: at these populations 0.02 is
one to two elements, so on the AC20 `none` stratum (n=25) losing a **single**
element takes 0.880 to 0.840 and the lane goes red.

**Recall cannot be bought with precision.** Every wrong pair increments exactly
one `negativeControls` counter, and all four have a ceiling of zero — so
precision below 1.0 is a hard failure before any precision floor is consulted.
That is verified rather than argued: the `over-eager` mutant is the engine with
its abstentions removed, and it matches or beats the real matcher's recall on
every model (1→1, 0.865→0.873, 0.950→0.959) while being rejected on
`falsePairs.wrongPartner` and on the precision floors. A recall floor alone
would have rewarded it. Duplex is the tie: since #2021 the real matcher recalls
every keyed element there, so the mutant can no longer buy recall on that model
and is rejected on precision alone — which is the point, stated the other way
round.

## First run: what it found (2026-08-03)

The first scored run came out **FAIL against the pre-registered numbers**, and
those failures are the point — they are findings F1 and F2 below. F1 is still
open; F2 was fixed by issue #2021 and this section records both the measurement
that found it and the one that closed it. The committed `scorecard.json` reads
**PASS** because the gating floors are a regression ratchet (see "Floors versus
targets"); the remaining shortfalls did not go away, they print on every run as
`BELOW PRE-REGISTERED TARGET`. Read the verdict as "nothing has regressed", not
as "the numbers are good".

The headline: across 3 models, 1 411 keyed elements of which 1 351 have a
counterpart, the matcher claimed **1 249 pairs and got 1 249 right — precision
1.000, zero false pairs, zero negative-control violations** — at an overall
recall of 0.925, while three pre-registered targets were
missed. By tier: 891 pairs from the geometry hash, 348 from the 1:1
residue, 10 from the positional tier — all three at precision 1.000. The
calibration stratum behaved: 10 re-sampled curved elements, **0** matched at
tier 1, **0** reported `renamed`, all 10 recovered by the lower tiers.

That leaves `1 351 − 1 249 = 102` keyed elements without a pair, and **all 102
are abstentions — `missed.silent` is 0 on every model**. Two counts in the
scorecard are easy to conflate here, so both are named: `missed.abstained`
(25 + 22 + 55 = **102**) counts elements *in the recall population* that the
matcher declined to pair, and it is the one that must reconcile with recall;
`overall.abstained` (33 + 30 + 63 = **126**) is the size of the abstained set,
which also contains entities outside that population. The claim "every miss is
an abstention" is about the first number.

**Where it stands after #2021.** The same 1 351-element population, same seeds,
same wasm: **1 288 pairs claimed, 1 288 right — precision still 1.000, still
zero false pairs and zero negative-control violations** — at an overall recall
of 0.953. By tier: 891 from the geometry hash (unchanged, as expected: the fix
is on the data side), 387 from the 1:1 residue (+39), 10 positional. The 63
remaining misses are all still abstentions, `missed.silent` still 0 on every
model. Duplex now recalls all 313 of its keyed elements. Every stratum on every
model either improved or held; none moved down.

Two findings came out of the first run, neither of them in the matcher:

**F1 — the world geometry hash is not invariant to entity ORDER, for elements
that go through opening CSG.** Isolated by three controls on `rvt01.ifc`:
re-parsing the same bytes changes 0 of 750 hashes, a scanner round trip (same
ids, same order, reformatted text) changes 0, and **reversing the statement
order alone changes 48**. In the fixture's own identity case (re-GUID +
express-id permutation, no geometric edit whatsoever) 52 of 750 flip on rvt01
and 2 of 286 on Duplex — exclusively `IfcWall`, `IfcWallStandardCase` and
`IfcCovering`, i.e. hosts whose mesh is cut by openings. The AABB deltas are
1e-6..1e-5 m: sub-micron float differences from a different CSG accumulation
order, crossing the 1 mm quantization grid. Downstream this is a false "this
changed" in Compare — the pair is still matched, but reported as `reshaped`
instead of `renamed`, which is why `byKind.renamed.kindAgreement` comes out at
0.944 — under its pre-registered **target** of 0.98, over its gating **floor**
of 0.924.

An earlier revision of this document quoted 0.949 for the same stratum. That
was the figure before the GlobalId generator changed; the new generator draws a
different number of PRNG values per GUID, which shifted the stream, hence the
express-id permutation, hence the CSG accumulation order. Nothing about the
matcher changed between the two runs. So the 0.005 gap between 0.949 and 0.944
is not noise to be explained away and not a regression: it is F1 itself, the
same order-sensitivity described above, measured end to end on a real model.
That 0.005 is the only movement this otherwise deterministic harness has ever
shown, which is why the gating margin is set at 0.02 — four times the largest
observed swing.

**F2 (FIXED by issue #2021) — the data fingerprint could not tell two type
objects apart when they differed only in `Tag`.** Duplex has eight
`IfcFurnitureType` entities all named `'800 mm'`, identical in every attribute
`buildDataFingerprint` hashed, differing only in `Tag` (`'157200'`, `'157607'`,
…) — which it did not hash, along with the representation maps. Type objects
carry no geometry hash either, so they landed in one bucket with nothing to
separate them and the engine correctly abstained. That was the whole of the
`byClass.none` shortfall (0.468 on Duplex against a 0.5 **target**) and most of
AC20-FZK-Haus's `renamed` recall of 0.738 against a 0.9 **target**: its misses
were 14 `IfcAnnotation`, 3 `IfcDoorType`, 3 `IfcVirtualElement`, 2
`IfcWindowType`.

`buildDataFingerprint` now hashes `Tag`, and the three shipped adapters (CLI,
MCP, viewer) supply it **for type objects only** — an occurrence's `Tag` is the
authoring tool's element id, so hashing it there would break matching across two
producers of one design, which is the scenario content matching exists for. What
that bought, per model:

| model | `byClass.none.recall` | `byKind.renamed.recall` | `overall.recall` |
| --- | --- | --- | --- |
| duplex | 0.468085 → **1** | 0.904215 → **1** | 0.920128 → **1** |
| AC20-FZK-Haus | 0.680 → **0.880** | 0.738095 → **0.797619** | 0.825397 → **0.865079** |
| rvt01 | 0.717514 → **0.768362** | 0.936047 → **0.946512** | 0.939693 → **0.949561** |

Precision stayed 1.000 on every stratum of every model and all four
negative-control counters stayed 0, which is the check that matters: recall
bought with precision is the failure mode this fixture was built to catch.

**What `Tag` does not reach, and why it is the geometry channel's problem.** The
misses that remain in `byClass.none` are three distinct populations, and none of
them is a fingerprint gap:

* **No `Tag` attribute at all** — `IfcAnnotation` (14 on AC20), `IfcGrid` (5 on
  rvt01). Both are `IfcProduct`s outside `IfcElement`, so IFC gives them no
  `Tag` to hash. AC20's 3 `IfcVirtualElement`s do have one and it is `$`, along
  with every other attribute they carry: nothing in the file distinguishes them.
* **A `Tag` that repeats** — rvt01's 27 `IfcMemberType`, 12 `IfcDoorType` and 2
  `IfcWindowType`. Revit writes one type entity per host and stamps them all with
  the same element id: all 27 mullion types carry `'29421'`. Their only real
  difference is geometric — `#22879` extrudes 1.2875 m and `#22912` 1.3125 m,
  through structurally identical `IfcRepresentationMap` subgraphs.

That second group is the "representation-map identity" half of #2021, and it was
evaluated and deliberately not done. A *structural* digest of the representation
maps (map count, representation identifier and type, item count) is identical
across all 27 and separates nothing; the only projection that separates them is
one that hashes the geometry, and putting that in the **data** fingerprint would
break the data/geometry split the rest of the pipeline is built on — a reshaped
type would read as a data change, and re-export float jitter would move a data
hash, which is exactly what the 4-dp quantity rounding exists to prevent. The
right home is a geometry hash for type objects: measured on this corpus, the
wasm pass (`buildPrePassOnce` + `processGeometryBatch`, the viewer's own path)
emits a geometry hash for **0 of 149** type objects on rvt01, 0 of 37 on Duplex
and 0 of 18 on AC20 — the type-geometry gate (#994) renders a type's own
representation only where the type has no occurrence, and here they all have
one. Closing that is a geometry-channel change and belongs in its own issue.

**F3 (observation, not acted on) — the shipped adapter spells `ifcType` two
different ways.** `IFCDOORSTYLE` and `IFCWINDOWSTYLE` appeared raw-uppercase in
the scorecard's `missed.byType` while every other class was PascalCase. They no
longer appear there at all: they were Duplex misses, and #2021 recovered every
one of them, so the scorecard's own evidence for this finding is gone while the
adapter behaviour that produced it is untouched. Reproduce it by fingerprinting
`duplex.ifc` and reading the `ifcType` of any `IFCDOORSTYLE`. That is
not a harness artefact: `buildFileFingerprints` takes the spelling from the
`EntityTable` when it holds the entity, and the parser's name-based branch
admits IFC2X3 `…STYLE` classes under their raw uppercase key, while
`comparableEntities` uses the registry's PascalCase for everything the table
does not hold. The registry *does* know `IfcDoorStyle`, so this is a spelling
inconsistency rather than a lookup failure.

It is left alone deliberately, twice over. `ifcType` is both the content bucket
key and part of the hashed `dataHash` payload, so normalizing it would change
the measurement — from inside the pull request whose job is to measure it. And
the scorecard's `byType` keys are a **verbatim echo** of what the adapter
returned; normalizing them in the harness would hide the inconsistency rather
than report it. Matching is unaffected, because both revisions of a pair go
through the same adapter and therefore agree. Worth its own issue against the
adapter, not a change here.

The pre-registered targets have NOT been moved to fit any of these numbers, and
the remaining shortfalls print on every run. What did change, in a separate
reviewed commit and with the argument written down above, is that the GATING
floors became a regression ratchet — because a permanently red required lane
teaches people to ignore a red X, and that is the failure this fixture exists to
prevent. `byClass.none.recall` reached its target the only way a target may be
reached here: the engine got better, the floor ratcheted up behind it
(0.448 → 0.748), and the target was never touched.

The harness mutation check rejects all three mutants on all three models:
always-match on 18-22 clauses (including `falsePairs.deletedBase 12 > 0`,
`falsePairs.insertedHead 8 > 0`, and `calibration.matchedByGeometryHash 8 > 0`),
always-abstain on 7-9 (recall 0 everywhere), and over-eager on 4-6 while
scoring recall at or above the real engine's. None survives.

Those clause counts are lower than an earlier revision of this document
reported (26/20/15), and the difference matters more than the numbers do. The
mutants used to be scored against the CORPUS clauses as well, whose
`populations` floors are computed from the answer key alone and never look at
what the matcher returned — so on AC20 (renamed 84 < 200, retriangulated 0 < 8,
inserted 4 < 12) and rvt01 (retriangulated 0 < 8) every mutant was rejected
before its matching behaviour was examined, and on those two models the check
could not have passed however good the mutant was. It proved nothing there. The
mutation check now scores mutants on per-pair clauses only, so every rejection
is a function of what the matcher actually returned. The conclusion survived
the correction; the evidence for it on two of three models did not.

## Second run: the claim stages (2026-09-18, issue #4955)

The first scored run of the four new mutations, against the thresholds
pre-registered in commit `2a0da8059`. Populations across the corpus:
respecified 38, thickened 24, swapped 12, splitLength 12, insertedNearby 12
(duplex 14/10/6/4/4, AC20 4/0/0/0/0, rvt01 20/14/6/8/8). The nearby control
rides ON the `deleted` population — rectangle-owning deleted elements are
relabelled — so every model still deletes exactly the 12 the plan declares. AC20 is sized down
on purpose: it has 126 keyed elements of which 17 can never be matched, so
every element a new role takes out of `renamed` moves that stratum's recall
towards its 0.777 floor, and seven is the most it can spare; its extrusions
are not rectangles and its only donor maps are mirrors (see the locality
rules above), so three of the new kinds have nothing to take there anyway.

What measured 1.0 everywhere it was populated, and whose floors therefore sit
at the ratchet ceiling: `respecified` recall, precision and kindAgreement
(38/38 paired at tier `geometry-only`, 0 reported `renamed`); `footprint`
recall and precision (24/24); `position` precision; `bySplit` recall and
kindAgreement (12/12, all `verified` — every half-length rectangle extrusion
was proved closed, so the volume attachment did what it was added for); the
`neighbourSuccessor` control (0). The content strata did not move: precision
1.000 on every model, all four original negative controls at 0.

Four shortfalls, each printed as a gap on every run, each a finding about the
engine or its adapters rather than the fixture, none tuned around:

All three findings below were **fixed in the engine stack** on the same day
(F4 in the parser, F5/F6 in `@ifc-lite/diff`) and the harness re-measured
against the fixed tip. The paragraphs keep the original measurement and the
repro as regression notes; the "after" numbers follow each.

**F4 (FIXED) — an unnamed spatial node switches the `position` profile off.**
`spatialContainerPath` spells an unnamed node as `#<expressId>`; Duplex's
`IfcBuilding` has no Name, so every container path in it reads
`0001/Default/#36/Level 1`, and no re-export preserves an express id. The
profile requires the path equal on both sides, so on Duplex it can never fire:
`bySuccessor.position.recall` 0.166667 there (the one recovered swap was a
same-size donor caught by `footprint`), 0.833333 on rvt01 where the building
is named, 0.5 across the corpus against a 0.6 target. The guard for container
paths reports rather than fails an `#` path for this reason. Repro:
`spatialContainerPath(store, id)` on `tests/models/ara3d/duplex.ifc` for any
contained element. *Fix:* an unnamed node is labelled by LongName, then by
class (`0001/Default/IfcBuilding/Level 1`), never by express id. *After:*
`bySuccessor.position.recall` 0.166667 → **0.333333** on duplex; the four
swaps still unclaimed there (and two on rvt01) are the harness pointing a
4.8 m window at a 0.75 m donor, or a stool at a bed, which F6's size check
now refuses on purpose — a donor-selection limit of the fixture, reported
as the standing corpus gap 0.5 < 0.6 rather than tuned around. The stable
paths also exposed a leak in the fixture itself: a `thickened` IfcSpace was
renamed, moving the container path of everything inside it. No #4955 role
is taken by a spatial element any more, and the container guard is what
caught it.

**F5 (FIXED) — a `duplicated` group is claimed as an `extent` split.** The content
pass reports two stacked copies of one element as a `duplicated` group and
retires nothing, so the whole and both copies stay in the residue; the split
stage's in-place lane then finds two same-class boxes inside the whole's box
covering its extent and, with no volume to refute it (furniture, coverings,
stairs — open shells by design), claims `extent`. Every wrong split claim in
the corpus is one of these: 7 on duplex, 1 on AC20 (its stair), 4 on rvt01,
one of which also absorbed an `insertedNearby` element as a third piece.
`bySplit.precision` 0.363636 / — / 0.666667 per model, 0.5 across the corpus
against 0.98. Two pieces whose boxes COINCIDE with each other cannot be a
split of anything, and the group they came from was already adjudicated.
Minimal repro: base `A` with box B; heads `A1`, `A2` with the same data hash
as `A` and the same box B, no volumes → `detectSplitMerge` claims
`{ kind: 'split', confidence: 'extent', whole: A, pieces: [A1, A2] }`.
*Fix:* the extent tier refuses any two pieces whose boxes coincide (IoU ≥
0.5). *After:* `bySplit.precision` 0.363636 / — / 0.666667 → **1 / — / 1**,
zero wrong claims in the corpus, 12/12 splits still `verified`.

**F6 (FIXED) — the `position` profile has no size check.** A deleted covering and a
head-only element of the same class at 0.3x its size, inside its box, are
paired as `position` successors at IoU 0.027: 7 of the 8 `insertedNearby`
controls on rvt01 (the eighth was bound as a piece of an F5 split claim, and
the successor stage skips what a split binds). The profile
argues from centre distance, container and uniqueness alone; a thickened wall
and a stool where a wall was look the same to it. `falseSuccessors.insertedNearby`
7 on rvt01 against a target of 0 — at the time the one gating ceiling that
had to be raised above zero, per pair and as a corpus total, with the target
left at 0 — and `bySuccessorConfidence.position.precision` 0.416667 against 0.98.
Minimal repro: deleted `D` with box `[0,0,0]..[5,0.2,3]`, added `N` of the
same class and container with box `[1.75,0.07,0]..[3.25,0.13,0.9]`, no other
residue → a `position` claim `D → N`. *Fix:* the profile requires every axis
extent within 2x of the other's. *After:* `falseSuccessors.insertedNearby`
7 → **0** (ceiling back to 0, per pair and corpus), and
`bySuccessorConfidence.position.precision` 0.416667 → **1** (4/4 on rvt01,
1/1 on duplex).

**Uniqueness margin, not a defect.** Two of rvt01's 14 thickened coverings
were recovered by `position` rather than `footprint` (kindAgreement
0.857143 against 0.9): the footprint profile abstains when a runner-up box
overlaps at half the threshold or more, and rvt01's stacked finishes provide
one. The pair was still found; the profile that found it is what the number
records.

The mutation check rejects all seven mutants wherever they apply. AC20
expects no claim, so `rotated-claims` and `silent-claims` are skipped there
and applied on the other two models; every other mutant is rejected on all
three, each on its own clause family.

## What is NOT in here

**A genuine foreign pair — two tools exporting one design — is not available in
`tests/models/`, so the fixture ships the synthetic family alone.** What the
corpus does contain is same-design twins across formats
(`ifc5/Hello_Wall_hello-wall.ifc` and `.ifcx`, the same for
`Domestic_Hot_Water`, `Georeferencing_georeferenced-bridge-deck`,
`buildingsmart/Building-Architecture.ifc` versus
`ifc5/PCERT-Sample-Scene_Building-Architecture.ifcx`, and the Railway IFC4X3 /
IFC5 pair). Every one of them is STEP-versus-IFCX, and the IFCX side identifies
nodes by UUID with no IFC `GlobalId` anywhere — so there is no channel from
which a correspondence could be derived by construction. A key for those pairs
would have to be authored by hand, which is a second opinion, not an answer key.
`fingerprints.mjs` already implements the `stripKeys` half of the protocol (the
key channel is removed from the fingerprints and its absence asserted) for
whenever such a pair does arrive.

Also absent, and worth stating:

* the fixture measures the **matcher**, not the viewer's compare UI or the
  identity-map sidecar;
* the fingerprint assembly is the CLI's `--geometry` code, not the viewer's
  (`apps/viewer/src/lib/compare/buildFingerprints.ts`), so a divergence
  between those two adapters is out of scope here — only `diff-fingerprints.test.ts`
  in `@ifc-lite/mcp` cross-checks the CLI adapter against a second copy;
* the mutation program applies one mutation per element. Compound edits (a
  wall that moved *and* was re-clad) are not covered — `thickened` and
  `swapped` each pair one geometry edit with a rename, which is the minimum a
  successor needs to exist at all, and `splitLength` renames both halves;
* `swapped` cannot be constructed on a model whose only donor maps are
  copies or mirrors of the element's own (AC20), and no mutation exercises a
  `merge` claim: the corpus has no element that is the union of two others.

## Cost and scheduling

`.github/workflows/xmatch-fixture.yml` runs this weekly and on demand, plus on
pushes and PRs that touch the code it measures (`packages/diff`,
`rust/geometry`, `packages/wasm`, the CLI diff adapter, and the harness itself).
A docs-only or viewer-only change never sees the job. The measurable work is a
few seconds per model; the wall clock is the wasm build and the fixture
download, both cached.
