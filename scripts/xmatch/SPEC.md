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
pnpm turbo build --filter=@ifc-lite/diff --filter=@ifc-lite/cli
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
| geometry hash + world AABB | the wasm mesh pass with `setComputeGeometryHashes(1e-3)` |
| the matcher | `diffModels(..., { scope: 'both', matchUnpairedByContent: true })` |

The one thing the harness supplies itself is the *pairing* of those two halves
(attach each entity's world hash and box to its data fingerprint), which is what
`apps/viewer/src/lib/compare/buildFingerprints.ts` does in the browser. That
viewer module could not be imported from a Node script (its `@ifc-lite/parser`
import cycles through `@ifc-lite/ifcx` under `tsx`), so the *assembly* is
duplicated while the *hashing* is not. A known limitation, listed again below.

## The answer key

A seeded mutation program (`mutate.mjs`) turns one real model from
`tests/models/` into a head revision and writes the true correspondence, keyed
by **source express id** — a channel the matcher never reads. The key is
produced by construction: the generator records what it did, rather than
deriving a correspondence from any hash or comparison.

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
* `deleted` / `duplicated` refuse unless every reference to the element sits
  inside a list;
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
   `renamed`).

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
`IfcCircle`, a B-spline, a swept disk, …). This stratum is not optional. The
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
* **The harness is mutation-checked, three ways.** `--self-test` swaps in an
  always-match matcher, an always-abstain matcher and an over-eager one, and
  asserts the fixture rejects all three. If any passes, the harness proves
  nothing and the run fails.

## Floors versus targets

Two numbers per stratum, because they answer different questions.

**The gating floor** is a ratchet against *regression*: the measured baseline
minus a 0.02 margin. It is what turns the lane red. Green means "no worse than
the last blessed measurement" — it is **not** a claim that the number is good.

**The pre-registered target** is what was written down in commit `79604caa`,
before the harness had produced a single number. It never gates, it is never
edited to match a result, and any stratum below it is printed on every run as
`BELOW PRE-REGISTERED TARGET`. Two lines print today. That is a standing debt,
deliberately impossible to lose track of:

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
* the fingerprint assembly is duplicated from the viewer adapter (see above), so
  a change to that adapter alone would not be caught here;
* the mutation program applies one mutation per element. Compound edits (a
  wall that moved *and* was re-clad) are not covered.

## Cost and scheduling

`.github/workflows/xmatch-fixture.yml` runs this weekly and on demand, plus on
pushes and PRs that touch the code it measures (`packages/diff`,
`rust/geometry`, `packages/wasm`, the CLI diff adapter, and the harness itself).
A docs-only or viewer-only change never sees the job. The measurable work is a
few seconds per model; the wall clock is the wasm build and the fixture
download, both cached.
