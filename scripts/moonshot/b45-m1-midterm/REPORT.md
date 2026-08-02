# B4.5: the M1 midterm, run as literally worded

Bet B4.5 of `docs/vision/moonshots-finishing-plan.md`. Apple M4 / 16 GB, warm
fixture cache.

**Every measured timing, node count and rate below is transcribed from a
committed artifact in this directory** - `scorecard.json` for the exam's own
run, `scorecard-no-aggregates.json` for the g0/g1 DAG shape. Everything else
carries an inline `<!-- numeral-ok: <token> :: <reason> -->` saying what it is
instead: a bar from the exam, a ratio computed in the sentence, or a figure
re-quoted from g0/g1's own separate runs. Every measured figure carries the
stronger `<!-- numeral-src: <token> :: <artifact>#<json.path> -->` binding,
naming the one field it comes from, because a mere "the artifacts hold this
number somewhere" clears it for the wrong reason - see the note under caveat 3
- and figures this document quotes only in order to retract them carry the
negative form `<!-- numeral-src: <token> :: none - <why> -->`, which blocks
that clearance outright.

`scripts/moonshot/ci/check-report-numerals.mjs --gate` is what holds this
directory at zero numerals that are neither. That checker arrived on `main`
with the finishing-plan branch that introduced it and is now in this tree, so
the paragraph above is machine-checked here rather than promised: the gate runs
green over this document, with every superseded figure bound negatively so no
coincidental hit in the artifacts can vindicate it. As of the fourth code
review, no numeral here is cleared by the artifact index at all: the checker
reports none backed, every one of them either bound to a named field or
asserted unbacked with a reason. That distinction is the whole point of the
instrument - being "backed" by an index of both scorecards clears a
deliberately-wrong number nearly a tenth of the time, and it was clearing six
of the counts below - the resolved count, the property-set leaves, the storeys,
the MeshData entries, the triangles and the vertices - against the OTHER DAG
shape's artifact rather than this run's; per-field
binding clears a wrong number in well under one case in a hundred.

*Correction history.* **2026-07-29 (a):** an earlier revision quoted numbers
from the original build run while the committed scorecard had been regenerated
by a later verification run, leaving eleven figures contradicting their own
artifact - the exact defect class the G4 review was convened over, reintroduced
by the commit that fixed the first instance of it. Node counts, percentages and
verdicts were unaffected; only wall-clock timings and peak RSS moved.
**2026-07-29 (b):** the adversarial re-review found the sentence that replaced
it - "every timing and node count below is transcribed from the committed
`scorecard.json`" - false for 19 of the 73 numerals in that revision, and found the
verify median stated twice with two different values (55.97 ms in two tables,
56.2 ms in caveat 3's row for this same shape; 56.2 was the *mean* of the five
spawns, not the median). Both are fixed, the g0/g1 shape now has a committed
artifact of its own instead of figures from an uncommitted run, and the
invariant is narrow enough to be true.
**2026-08-01 (first code review):** hosted CodeRabbit had reported "pass - review
rate limited" on this PR, i.e. it never looked; the CLI run that replaced it
found the verifier taking its own trust anchor out of the bundle. Fixed, with
the forgery that proved it added to the tamper battery. No published figure
moved: every node count, percentage, hit rate, clause verdict and the verified
count are identical before and after, because every bundle in the corpus is
produced by this runner and none of them was forged.
**2026-08-01 (second code review).** The hosted reviewer was rate-limited again,
so the CLI ran again and returned a disjoint set of findings - which is itself
the finding: that reviewer is non-deterministic, and one clean pass from it is
not evidence. Two held. First, the verifier sized its work from the bundle: it
read the file and decoded every payload before any hash was checked, so a
hostile bundle could exhaust the heap. It now takes both a maximum file size
and a maximum total decoded payload from the parent - the same place the trust
anchor comes from, and for the same reason - and checks each BEFORE the
allocation it bounds, rejecting with `bundle-too-large` or `payload-too-large`.
That matters because the failure it replaces was not a wrong answer but no
answer: the pre-fix worker aborted on a heap OOM and wrote nothing to stdout,
and a verifier that dies on bad input drops that bundle out of the count
instead of counting it as rejected. Second, the tamper battery asserted only
that each case was *caught*, never that it was caught for the reason it was
written to prove; the forged-anchor case flips a child hash and re-derives the
claim hash, so if that re-derivation ever broke it would come back green on
`hash-mismatch` while testing nothing. Each case now declares the rejection
reason it requires. Again no published figure moved: the caps are far above
anything this bet produces and are never reached on an honest run, and the
reason assertion tightened a check without changing what is measured.
**2026-08-02 (fourth code review).** Two held, and both are the same shape as
the three before them: a check that could not fail. First, every run shared one
fixed working directory in `$TMPDIR`, and every run ends by deleting it.
Measured rather than argued - two runs started together on `duplex.ifc` and
`AC20-FZK-Haus.ifc`, six trials - the slower run lost its tamper bundles
mid-battery in six of six, and in five of those the forged-trust-anchor case
came back `caught: true, altered: true` with reason `unreadable-bundle`:
rejected because its file had been deleted under it, not because the anchor
check fired. Under the catch-only assertion this script carried until the
previous review round that is a green tamper battery on a `verdict: "PASS"`
scorecard - reproduced, two of three trials, and the process exited green. The
silent form is worse, because nothing rejects anything: every bundle this bet
writes is
stamped with the same trust root and kernel version, so one run's bundle
verifies `ok: true` in another run's worker, and the FZK bundle placed at the
duplex run's path returns `ok: true` resolving 8 nodes where the genuine bundle
resolves 22 - clauses 1 and 2 measured over a different model, reported against
this run's denominator. The working directory is now per-run (`mkdtemp`), and
the runner asserts that the verifier resolved exactly as many distinct nodes as
this run put in the bundle, because a verifier that accepts any
internally-consistent bundle under the same anchor structurally cannot tell the
runner it was handed the wrong one. Both halves were re-measured after the fix:
six of six clean, and the payload assertion fires eight of eight when the shared
path is forced back on with `B45_OUT`. Second, the from-scratch cross-check was
recorded and not judged. Forcing a divergence (corrupting one property-set
payload before the rebuild) produced `correctnessCrossCheck: false` next to
`verdict: "PASS"` and a green exit: an incremental DAG that no longer agrees with
a rebuild, published as a pass. It is in the verdict now and the run exits
non-zero; the same construction after the fix gives `verdict: "FAIL"` and a
non-zero exit. One finding was refuted by construction: the same review held
that a failing tamper case was "merely recorded" too, and it is not - a case
rigged to mutate nothing aborts the run with no scorecard written, which is
also why the
`unreadable-bundle` catch above was visible at all. No published figure moved:
nothing was re-blessed, and two full re-runs of the exam reproduced every node
count, rate, hit rate and clause verdict in `scorecard.json` identically, with
the verify median inside 2% both times.

**2026-08-01 (third code review).** The CLI ran a third time, returned a third
largely disjoint set, and found the same class of defect in the same file for
the third time. The bundle cap was checked against `statSync(path).size` and
the file was then read again by path with `readFileSync`, which bounds a number
that DESCRIBES the file rather than the bytes a read will yield. For any path
where those differ - a FIFO, a character device, or a regular file swapped
between the two syscalls - the cap did not apply at all. Shown by construction
rather than argued: a bundle streamed through a FIFO cleared a cap set far
below its size and was parsed and verified in full, and at a larger stream the
worker's peak RSS tracked what the producer chose to send rather than the cap -
which is the unbounded-allocation failure the previous round's fix was supposed
to have closed, still open through a different door. The worker now reads
through one opened descriptor and stops one byte past the cap, so an oversized
bundle is rejected as `bundle-too-large` having never been held. The same pass
also moved every measured figure in this document from "backed by the artifact
index" to bound to the one field it comes from, which is where the note at the
top about the index clearing the wrong artifact comes from. Two of its prose
findings were refuted rather than fixed: sanitising the fixture census away
would delete measurements of a public open-source test model, which is what
this document exists to publish, and the `~35 s` note in the Reproducing block
sits inside a fenced code block that the checker ignores by design and is a
runtime hint rather than a measured claim. Once again no published figure
moved: nothing was re-run, nothing was re-blessed, and the caps are never
reached on an honest run.

`scorecard.json` WAS re-blessed (`--write-scorecard`), deliberately and at a
cost worth stating. Leaving it alone would have been cheaper: the committed
artifact would then hold only the two older tamper cases, so the evidence would
not show the forgery being caught, and the artifact would describe code that no
longer exists. That is the same artifact-versus-code gap this document's
2026-07-29 entries are about, so it was not an acceptable thing to leave behind
for tidiness. The price is that the wall-clock figures moved with it, and every
one of them has been re-derived from the new artifact rather than adjusted by
hand: verify median 55.97 -> 55.53 ms (clause-1 margin 8.9x -> 9.0x), whole
process 83.2 -> 82.3 ms, parse 2.80 -> 2.93 s, mesh 8.08 -> 8.00 s, DAG
structure 1.11 -> 1.04 s, DAG build 9.46 -> 9.51 s, single-wall recompute
5.39 -> 6.29 ms (property) and 8.45 -> 7.69 ms (geometry+property), verifier
RSS 71.5 -> 71.7 MB, builder RSS 2.47 -> 2.77 GB, and the g0 comparison
+11.5% -> +10.6%. Node counts, percentages, hit rates, the verified count and
all three clause verdicts are unchanged, which is the point: nothing the exam
is judged on depends on which minute the run happened.

The one pair NOT re-derived is the 53.9 -> 56.0 ms geometry-inflation
measurement. The scorecard stores no pre-inflation field, so those two come
from a separate instrumented run and cannot be recomputed from the committed
artifact; they are labelled as such where they appear rather than being
silently refreshed to numbers no artifact backs.

<!-- numeral-src: 55.97, 55.97ms, 8.9x, 83.2, 2.80, 8.08, 1.11, 9.46, 5.39,
     8.45, 71.5, 2.47, +11.5% :: none - the pre-re-bless figures, quoted in
     this document only to record what the re-bless moved. Each was emitted by
     the superseded scorecard and is emitted by nothing in this tree now, so
     they are bound negatively rather than left to the artifact index: the
     sentences carrying them are true only while they read as unbacked, and a
     coincidental hit would make each of them say the opposite of what it
     says. -->
<!-- numeral-src: 8, 22, 2% :: none - counts and a spread from the adversarial
     reproduction runs of the 2026-08-02 round, taken on duplex.ifc and
     AC20-FZK-Haus.ifc rather than on the exam's fixture. No scorecard in this
     directory stores them, and none should: they are properties of the harness
     under concurrency, not of the M1 midterm. Bound negatively rather than
     merely excused because the union index CLEARS 8 by coincidence, and a
     resolved-node count from a two-megabyte demo model reading as "backed" by
     some unrelated field of the 169 MB run is the pathology the note at the top
     of this document is about. -->
<!-- numeral-ok: 19, 73 :: counts OF this document at its previous revision,
     produced by scripts/moonshot/ci/check-report-numerals.mjs against that
     revision. A measurement of the prose, not of the bet. -->
<!-- numeral-ok: 16GB :: the host machine's RAM. No scorecard field records it. -->

<!-- Every figure the re-bless moved, bound to the field it was re-derived
     from. All of them already read as "backed" before this, but only against
     the index of both scorecards together, where a deliberately-wrong number is
     cleared 9.3% of the time - and where six of this document's own counts were
     being cleared by the OTHER DAG shape's artifact, which is the wrong source
     for a sentence about this one. A named field is a haystack of
     one, so each of these now fails the gate if the artifact moves under it. -->
<!-- numeral-src: 55.53ms :: b45-m1-midterm/scorecard.json#verifyMedianMs -->
<!-- numeral-src: 82.3ms :: b45-m1-midterm/scorecard.json#verifyWholeProcessWallMedianMs -->
<!-- numeral-src: 2.93s :: b45-m1-midterm/scorecard.json#parseMs -->
<!-- numeral-src: 8.00s :: b45-m1-midterm/scorecard.json#meshMs -->
<!-- numeral-src: 1.04s :: b45-m1-midterm/scorecard.json#dagStructureMs -->
<!-- numeral-src: 9.51s :: b45-m1-midterm/scorecard.json#dagBuildMs -->
<!-- numeral-src: 6.29ms :: b45-m1-midterm/scorecard.json#examA_propertyOnlyWallEdit.recomputeMs -->
<!-- numeral-src: 7.69ms :: b45-m1-midterm/scorecard.json#examB_propertyPlusGeometryWallEdit.recomputeMs -->
<!-- numeral-src: 71.7MB :: b45-m1-midterm/scorecard.json#verifierMaxRssBytes -->
<!-- numeral-src: 2.77GB :: b45-m1-midterm/scorecard.json#peakRssBytes -->

## Why this bet existed

The M1 midterm had never been run in its stated form. Two halves existed
separately and were quoted as one result:

- `g0-certificate-demo.mjs` ran at 169 MB scale but **data plane only**, with
  no geometry-mesh leaves in the DAG.
- `g1-memoized-recompute.mjs` carried real mesh leaves but on **duplex**, a
  small model.

So "certificate verified in 63 ms resolving 0.052% of nodes on a 169 MB model"
was a data-plane number wearing a mesh-bearing model's headline. This bet runs
all three clauses at once, with mesh leaves present throughout.

<!-- numeral-src: 169MB :: b45-m1-midterm/scorecard.json#fixtureBytes -->
<!-- numeral-src: 63ms :: none - g0's own published data-plane figure. g0 writes
     no scorecard, so nothing in this tree emits it. It is bound negatively
     rather than left to the union index because the union CLEARS it by
     coincidence: scorecard-no-aggregates.json's verifyAllMs[1] is 62.654, a
     single spawn of a different DAG shape on a different day, which rounds to
     63 and has nothing to do with g0. -->

## Verdict: PASS on all three clauses

| Clause | Bar | Measured | Verdict |
|---|---|---|---|
| 1. Verified in a second process | < 500 ms | **55.53 ms** (median of 5 spawns) | PASS, 9.0x margin |
| 2. DAG nodes resolved | < 5% | **0.0239%** (60 of 250,582) | PASS |
| 3. Cache hits, single-wall recompute | > 90% | **99.9956%** geometry+property; **99.9984%** property-only | PASS |
| Mesh leaves genuinely present | not zero | **109,632** leaves, 43.8% of the DAG, 7 rewritten by the edit | YES |

<!-- numeral-src: 500ms, 5%, 90% :: none - the exam's own bars, quoted in the
     Bar column. A bar is a threshold this bet is judged against, not a value it
     produces, so it must never read as backed. Bound negatively rather than
     merely excused because the union index CLEARS all three by coincidence:
     90% against verifyWholeProcessWallMedianMs 90, and 5% against the digits of
     the string "B4.5" in the scorecard's own `bet` field. -->
<!-- numeral-src: 7 :: b45-m1-midterm/scorecard.json#examB_propertyPlusGeometryWallEdit.meshLeavesEdited -->
<!-- numeral-ok: 9.0x, 43.8% :: computed on the line from committed fields -
     9.0x is the 500 ms bar over verifyMedianMs 55.532, 43.8% is nodesMeshLeaves
     109,632 over nodesTotal 250,582. The scorecard stores the operands; the
     ratio is the row's own arithmetic. -->
<!-- numeral-src: 0.0239% :: b45-m1-midterm/scorecard.json#nodesResolvedPct -->
<!-- numeral-src: 60 :: b45-m1-midterm/scorecard.json#nodesResolvedDuringVerify -->
<!-- numeral-src: 250,582 :: b45-m1-midterm/scorecard.json#nodesTotal -->
<!-- numeral-src: 109,632 :: b45-m1-midterm/scorecard.json#nodesMeshLeaves -->
<!-- numeral-src: 99.9956% :: b45-m1-midterm/scorecard.json#examB_propertyPlusGeometryWallEdit.hitRate -->
<!-- numeral-src: 99.9984% :: b45-m1-midterm/scorecard.json#examA_propertyOnlyWallEdit.hitRate -->
<!-- numeral-src: 1 :: none - the DAG's single root in the census below, and the
     "1." that numbers clause 1 in the table above. No field stores either, and
     the artifact index was clearing this token against a digit embedded in the
     scorecard's own "exam" STRING. -->
<!-- numeral-src: 2, 3, 5, 2x :: none - ordinals and structural counts, not
     measurements: the clause numbers, the caveat number, the count of verify
     spawns ("median of 5 spawns" - the scorecard stores the five samples in
     verifyAllMs, not their count), and the "2x2" of claim granularity by DAG
     shape. Each was being cleared by an unrelated field - 5 against a 453.5 ms
     verify timing scaled by 1/100, 2x against a bundle-parse median - which is
     the union-haystack pathology reaching inside a single bet's own index. -->

Fixture: `tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc`,
177,465,622 bytes, 2,807,815 entities.

<!-- numeral-src: 177,465,622 :: b45-m1-midterm/scorecard.json#fixtureBytes -->
<!-- numeral-src: 2,807,815 :: b45-m1-midterm/scorecard.json#entities -->

### Node census

| Kind | Count |
|---|---|
| Total DAG nodes | 250,582 |
| `geometry-mesh` leaves | 109,632 |
| `property-set` leaves | 80,104 |
| `element` | 60,795 (39,028 reached via aggregates) |
| `storey` | 50 |
| `root` | 1 |
| MeshData entries emitted | 110,632 (2,934,427 triangles, 4,593,788 vertices) |

99.1% of the MeshData entries the mesher emitted have a `geometry-mesh` leaf in
the DAG (109,632 of 110,632). That is a count of entries and not a measure of
geometry: the 1,000 entries without a leaf are unweighted by size, so this says
nothing about what share of the model's triangles they carry.

<!-- numeral-ok: 99.1% :: nodesMeshLeaves 109,632 over meshDataEntries 110,632,
     computed in the sentence from two committed fields. -->
<!-- numeral-src: 1,000 :: b45-m1-midterm/scorecard.json#meshDataUnattached -->
<!-- numeral-src: 80,104 :: b45-m1-midterm/scorecard.json#nodesPropertySetLeaves -->
<!-- numeral-src: 60,795 :: b45-m1-midterm/scorecard.json#nodesElements -->
<!-- numeral-src: 39,028 :: b45-m1-midterm/scorecard.json#nodesElementsViaAggregates -->
<!-- numeral-src: 50 :: b45-m1-midterm/scorecard.json#nodesStoreys -->
<!-- numeral-src: 110,632 :: b45-m1-midterm/scorecard.json#meshDataEntries -->
<!-- numeral-src: 2,934,427 :: b45-m1-midterm/scorecard.json#triangles -->
<!-- numeral-src: 4,593,788 :: b45-m1-midterm/scorecard.json#vertices -->

### Construction versus verification

These are different quantities and only the second is what the exam bounds.

| Stage | Time |
|---|---|
| Parse | 2.93 s |
| Mesh | 8.00 s |
| DAG structure | 1.04 s |
| DAG build + full hash | 9.51 s |
| **One-time construction total** | **~21 s** |
| **Second-process verification** | **55.53 ms** |
| Whole verifier process incl. Node startup | 82.3 ms (also under the bar) |
| Bundle deserialize (timed outside the verify region) | 2.16 ms |
| Single-wall recompute | 6.29 ms (property) / 7.69 ms (geometry+property) |

Peak RSS: builder 2.77 GB, **verifier 71.7 MB**. The asymmetry is the point of
M1: constructing the proof is expensive and happens once; checking it is cheap
and happens everywhere.

<!-- numeral-src: 2.16ms :: b45-m1-midterm/scorecard.json#verifyBundleParseMedianMs -->
<!-- numeral-ok: 21s :: the sum of the four stage timings in the table above
     (parseMs 2,925 + meshMs 7,997 + dagStructureMs 1,039 + dagBuildMs 9,508 =
     21.47 s), written as "~21 s". The scorecard stores the addends. -->

### Correctness checks that came with it

- **From-scratch cross-check:** rebuilding the DAG from nothing reproduces the
  incrementally-updated DAG hash for hash. It is a term of the verdict, not a
  note beside it: a run whose rebuild disagrees writes `verdict: "FAIL"` and
  exits non-zero. It was the other way round until the fourth review round, and
  the correction history above records what that looked like.
- **Tamper, three cases, all caught:** one `f32` byte flipped inside a mesh
  payload and one child hash altered in a storey the certificate claims is
  untouched, both `hash-mismatch`; and a forged bundle carrying its own trust
  anchor, `bundle-carries-trust-anchor`. Each case also records `altered`, the
  evidence that it changed something - a tamper case that mutates nothing is a
  green cell carrying no information.
- **The verifier's trust anchor comes from the runner, not the bundle.** The
  first revision of `verify-worker.mjs` read `expectedTrustRoot` and
  `expectedKernelVersion` out of the artifact it was checking, which makes the
  spec §4 pin vacuous. It was not theoretical: a bundle with a tampered child
  hash under an untouched storey, the claim's hash re-derived so the certificate
  agreed with the lie, and an attacker-chosen trust root stamped on both the
  certificate and the bundle's `expected*` fields verified `ok: true` with every
  claimed node resolved - byte for byte as convincing as the genuine one. Both
  expectations now arrive through the environment the runner controls, a bundle
  that still carries them is rejected outright, and the forgery is case three of
  the tamper battery so it cannot quietly come back.

## The question this bet was set to ask

**Does the data-plane number survive contact with mesh leaves? Yes.**
50.21 ms (g0 data-plane-only, re-run on this machine) to 55.53 ms mesh-bearing:
+10.6%. Inflating the edited wall's geometry 46x (24 to 1,106 vertices) moved
verification 53.9 to 56.0 ms (both from an instrumented run predating the
2026-08-01 re-bless; the scorecard stores no pre-inflation field, so these two
are not re-derivable from it and the re-bless did not update them -- the
comparison they support is a ratio, and it is unaffected). The reason is structural rather than lucky:
verification cost is dominated by re-hashing the 49 untouched-storey
`relationship` nodes, not by geometry payload size.

<!-- numeral-ok: 50.21ms, +10.6% :: 50.21 ms is g0's data-plane-only verify
     median re-run on this machine; g0 writes no scorecard, so it has no
     artifact here, and +10.6% is this paragraph's own comparison of it against
     55.53 ms. -->
<!-- numeral-ok: 46x, 49 :: 46x is examB's verticesMoved 1,106 over the wall's
     original 24, and 49 is nodesStoreys 50 minus the one storey the edit
     touches. Both ratios are computed in the sentence. -->
<!-- numeral-src: 24 :: none - the edited wall's original vertex count, an input
     to the 46x ratio, read off the mesh during the variant run and stored by
     neither scorecard. Bound negatively because the union index clears it
     against scorecard-no-aggregates.json's parseMs, 2423 ms scaled by 1/100 -
     a parse timing standing in for a vertex count. -->
<!-- numeral-src: 1,106 :: b45-m1-midterm/scorecard.json#examB_propertyPlusGeometryWallEdit.verticesMoved -->
<!-- numeral-src: 53.9, 56.0ms :: none - the pre- and post-inflation verify
     medians, from a separate instrumented run predating the 2026-08-01
     re-bless. The scorecard stores no pre-inflation field, so neither is
     re-derivable from it and neither was refreshed with the rest; they support
     a ratio, and they must stay unbacked for the sentence to be true. -->

## Four caveats, including one that cuts against the headline

### 1. Mesh leaves made clause 2 arithmetically easier, and that is not banked

Adding mesh leaves moved the denominator 101,922 to 250,582 while resolved
nodes moved only 53 to 60. The percentage "improved" from 0.052% to 0.0239%
for reasons that have nothing to do with the system getting better. **The
invariant worth quoting is the count: 60 nodes.** Against the hardest honest
denominator (mesh leaves excluded) the figure is 0.0426%.

<!-- numeral-src: 0.0426% :: b45-m1-midterm/scorecard.json#nodesResolvedPctIfMeshLeavesExcludedFromDenominator -->
<!-- numeral-src: 101,922, 0.052%, 53 :: none - g0/g1's own no-mesh node count,
     resolved share and resolved count. Those demos write no scorecard, so all
     three are quoted from their published runs and no artifact in this
     directory emits them. Bound negatively rather than excused because the
     union index clears 53 against the digits of the fixture PATH string. -->

### 2. Clauses 1 and 2 are properties of the CLAIM, not of the DAG

Measured counterfactual, same edit and same reads/writes, with
`subtree-untouched` claimed at **element** granularity instead of g0's
**storey** granularity:

| Claim granularity | Nodes resolved | % | Verify | Clause 1 | Clause 2 |
|---|---|---|---|---|---|
| storey (the exam) | 60 | 0.0239% | 55.53 ms | PASS | PASS |
| element | 60,805 | 24.27% | 845.6 ms | **FAIL** | **FAIL** |

<!-- numeral-src: 60,805 :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.nodesResolved -->
<!-- numeral-src: 24.27% :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.nodesResolvedPct -->
<!-- numeral-src: 845.6ms :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.verifyMs -->

Every cell of that row is bound to the field it comes from rather than left to
the artifact index. It is the row this document has now got wrong twice - once
by quoting a verify timing no artifact held, and once by carrying the previous
one through a re-bless that moved the field under it - and a per-claim binding
is the only check that can say a sentence contradicts the field it quotes.

Any future quote of "under 500 ms, under 5%" must carry the qualifier
**"for a storey-granularity claim"**. Without it the number is not reproducible
and is arguably not honest.

*Correction, 2026-07-29 (G4 review), and a correction to that correction.* An
earlier revision of this table carried a third row - "g0/g1 narrower shape,
21,777 nodes, 12.62%, 465.4 ms, FAIL" - which was removed on the grounds that
**no artifact produces it**. That was true of the committed artifacts and wrong
about the measurement. Committing the `--no-aggregates` run
(`scorecard-no-aggregates.json`, added the same day) shows where the row came
from:

| Field | Value |
|---|---|
| `sensitivityElementGranularityClaim.nodesResolved` | 21,777 |
| `sensitivityElementGranularityClaim.nodesResolvedPct` | 12.6224 |
| `sensitivityElementGranularityClaim.verifyMs` | 453.5 |
| `sensitivityElementGranularityClaim.wouldPassClause2` | false |

So the row was an **element-granularity claim measured on the g0/g1 DAG shape**
- a fourth cell of a 2x2 (two claim granularities x two DAG shapes), not a third
claim granularity. `run.mjs` still implements exactly two claim granularities;
what the row conflated was the two axes, by sitting in a table that varies only
one of them. It remains removed from that table because it does not belong
there, and its verify figure was in any case a different run's (453.5 ms in the
committed artifact against the 465.4 ms the row carried).

<!-- numeral-src: 21,777 :: b45-m1-midterm/scorecard-no-aggregates.json#sensitivityElementGranularityClaim.nodesResolved -->
<!-- numeral-src: 12.62%, 12.6224 :: b45-m1-midterm/scorecard-no-aggregates.json#sensitivityElementGranularityClaim.nodesResolvedPct -->
<!-- numeral-src: 453.5, 453.5ms :: b45-m1-midterm/scorecard-no-aggregates.json#sensitivityElementGranularityClaim.verifyMs -->
<!-- numeral-ok: 465.4ms :: the verify timing the removed row carried, quoted
     only to show that it does NOT match the committed 453.5 ms. From an
     uncommitted run; it must stay unbacked. -->

The correction that removed it therefore overstated: the numbers were not
invented, they were unattributed. Both the row and this paragraph are the same
underlying defect - a figure with no committed artifact behind it - and the fix
in both directions is the artifact, which now exists.

### 3. g0/g1's DAG shape silently drops 36% of this model's MeshData entries

`g0` and `g1` reach elements only through `IfcRelContainedInSpatialStructure`.
On Holter that misses **40,028 of 110,632** MeshData entries - that is
`meshDataUnattached` in `scorecard-no-aggregates.json`, and it equals this bet's
own `nodesElementsViaAggregates` 39,028 plus its `meshDataUnattached` 1,000. It
is dominated by 27,427 `IfcMember` and 11,469 `IfcPlate` - the curtain-wall
system, which is aggregated into hosts rather than contained by storeys. Those
two types alone account for 38,896; the remainder is other aggregated element
types. This bet widened the traversal to follow `IfcRelAggregates` as well and
ran both shapes:

<!-- numeral-ok: 27,427, 11,469, 38,896 :: the per-type breakdown of the missed
     entries, counted from the fixture during analysis; neither scorecard stores
     a per-ifcType census, and 38,896 is their sum, added in the sentence. -->
<!-- numeral-ok: 36% :: 40,028 over 110,632, computed in the heading and in this
     sentence from two committed fields. -->
<!-- numeral-src: 40,028 :: b45-m1-midterm/scorecard-no-aggregates.json#meshDataUnattached -->
<!-- numeral-src: 172,526 :: b45-m1-midterm/scorecard-no-aggregates.json#nodesTotal -->
<!-- numeral-src: 0.0348% :: b45-m1-midterm/scorecard-no-aggregates.json#nodesResolvedPct -->
<!-- numeral-src: 60.86ms :: b45-m1-midterm/scorecard-no-aggregates.json#verifyMedianMs -->

| Shape | Nodes | Resolved % | Verify | Verdict | Artifact |
|---|---|---|---|---|---|
| contained + aggregated (this bet) | 250,582 | 0.0239% | 55.53 ms | PASS | `scorecard.json` |
| contained only (g0/g1) | 172,526 | 0.0348% | 60.86 ms | PASS | `scorecard-no-aggregates.json` |

The two verify medians come from separate runs on separate days, and run-to-run
spread on this machine is larger than the gap between those two cells, so the
difference between them says nothing about DAG shape. What the shape changes is
the denominator, which is the caveat's whole point. (An earlier revision gave
the first row as 56.2 ms - the *mean* of the five spawns - while every other
table here quoted the *median*, 55.97 ms in that revision. Corrected: the
median is what `scorecard.json` stores and what clause 1 is judged on. Both of
those figures belong to the pre-re-bless run; the current median is 55.53 ms.)

<!-- numeral-src: 56.2ms, 56.2 :: none - a RETRACTED figure, quoted only to say it was
     wrong, and it must stay retracted. The union index clears it against
     scorecard.json's verifyAllMs[2] = 56.164 - one of the five spawn samples,
     not the mean this sentence is disowning - so leaving it unbound would have
     the checker vindicate the very number the paragraph exists to withdraw. -->

The exam passes either way and the resolved count is stable at 53-60 across
all three DAG shapes measured - 60 in both rows of the table above, 53 in g0's
mesh-free shape, which is the third and is not in that table because it has no
mesh leaves to compare. Only the denominator moves. But **the published g0/g1
node counts undercount the model's MeshData entries on any model that uses
aggregation**, which is most real curtain-walled buildings. That is a defect in the demos' traversal, not
in M1.

### 4. "Second process" is the wording this bet was graded against; the original said "second browser"

Worth stating plainly, because this document's title says *as literally
worded* and there are two wordings. The exam B4.5 was set is
`docs/vision/moonshots-finishing-plan.md`'s restatement: *certificate verified
in a second process*. The M1 midterm as first written, in
`docs/vision/moonshots-execution-plan.md`, says *a certificate a second
**browser** verifies*. This bet did the former. It did not run the verifier in a
browser.

What that substitution can and cannot move is worth being exact about rather
than waving at. It cannot move the verdict of verification: the hash is
`crypto.subtle.digest('SHA-256')` in `@ifc-lite/provenance`, the same WebCrypto
call with the same standardised digest in Node and in a browser, so a bundle
that verifies in one verifies in the other and a tampered bundle fails in both.
What it can move is the number clause 1 is judged on. A browser adds an engine
this was never timed on, a different `JSON.parse` of the bundle, and a page
lifecycle instead of a process spawn. So the honest reading of the clause-1
figure is: **measured in a second OS process, not in a second browser.** Closing
that is a separate run, and it belongs to whoever wants the original wording
back.

### Smaller caveats

- The committed `scorecard-no-aggregates.json` predates the forged-trust-anchor
  tamper case and the `altered` field, so its `tamper` array has two entries
  where a run of the current script produces three. Every figure this document
  binds to that artifact is a node count or a rate, and all of them reproduce to
  the digit under the current script; the two timings it backs could not be
  re-measured usefully at the time of writing (the host was oversubscribed
  enough to inflate the same run's verify median by more than a factor of two),
  so it has been left alone rather than re-blessed with contention artifacts.
  Re-bless it with `--no-aggregates --write-scorecard` on a quiet machine and
  re-derive the two figures it moves.
- `reads` is empty because Holter's walls carry exactly one pset each (g0
  documented the same; duplex yields 9 reads).
- Trust root, kernel version and root `layerId` are placeholders, as in
  g0/g1/b35.
- Class-2 instanced templates excluded per g1 (zero on this fixture).
- Single machine, single fixture, warm cache.

<!-- numeral-ok: 9 :: the read count g1 reports on duplex, quoted from that
     demo's own run. Neither scorecard here stores a read census, and this
     bet's fixture produces none at all. -->

## Reproducing

```bash
node scripts/moonshot/b45-m1-midterm/run.mjs              # ~35 s end to end
node scripts/moonshot/b45-m1-midterm/run.mjs --probe      # cheap parse+mesh dry run
node scripts/moonshot/b45-m1-midterm/run.mjs --no-aggregates  # the g0/g1 shape
```

Needs the Holter fixture. Without it the runner now exits non-zero naming the
fetch command rather than throwing out of the loader, and it does not exit green:
nothing in `.github/workflows` runs this script, its Holter-gated siblings g0
and g1 are gated from outside by the workflow rather than self-skipping, and a
silent green inside the one script whose whole output is a verdict is how a bet
gets scored on a run that never happened. The command it prints is

```bash
FIXTURE_TIMEOUT_MS=600000 node scripts/fixtures/fetch-fixtures.mjs \
  ara3d/ISSUE_053_20181220Holter_Tower_10.ifc
```

(`pnpm fixtures` fetches the whole catalogue; the argument is a path under
`tests/models`, and `FIXTURE_TIMEOUT_MS` is needed because the 60 s default
aborts a 177 MB pull). The
runner self-execs with a raised heap; working bundles including the 36.5 MB
element-granularity sensitivity bundle go to a fresh per-run temp directory and
are removed on exit. Machine-readable results in `scorecard.json` and, for the
g0/g1 shape, `scorecard-no-aggregates.json`.

<!-- numeral-src: 177MB :: b45-m1-midterm/scorecard.json#fixtureBytes -->
<!-- numeral-src: 36.5MB :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.bundleBytes -->
<!-- numeral-src: 60s :: none - the fixture fetcher's default timeout, a
     constant of a different script. It is bound negatively because the union
     index CLEARS it against nodesResolvedDuringVerify, which is the integer 60
     and has nothing to do with seconds: a timeout reading as "backed" by a node
     count is the union-haystack pathology this document's caveat-3 note is
     about. -->

**The plain run does not touch the committed scorecard.** It writes to a temp
path and prints where. Re-blessing is `--write-scorecard`, and under
`--no-aggregates` that writes `scorecard-no-aggregates.json`, never
`scorecard.json`. An earlier revision always wrote `scorecard.json` next to the
script, which meant the reproduction command printed above destroyed the source
of truth this document is checked against - and the `--no-aggregates` line
destroyed it with figures from a different DAG shape.
