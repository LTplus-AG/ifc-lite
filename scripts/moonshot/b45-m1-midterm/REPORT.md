# B4.5: the M1 midterm, run as literally worded

Bet B4.5 of `docs/vision/moonshots-finishing-plan.md`. Apple M4 / 16 GB, warm
fixture cache.

**Every measured timing, node count and rate below is transcribed from a
committed artifact in this directory** - `scorecard.json` for the exam's own
run, `scorecard-no-aggregates.json` for the g0/g1 DAG shape. Everything else
carries an inline `<!-- numeral-ok: <token> :: <reason> -->` saying what it is
instead: a bar from the exam, a ratio computed in the sentence, or a figure
re-quoted from g0/g1's own separate runs.
`scripts/moonshot/ci/check-report-numerals.mjs --gate` holds this directory at
zero numerals that are neither, so the sentence above is machine-checked rather
than promised.

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

<!-- numeral-ok: 19, 73 :: counts OF this document at its previous revision,
     produced by scripts/moonshot/ci/check-report-numerals.mjs against that
     revision. A measurement of the prose, not of the bet. -->
<!-- numeral-ok: 16GB :: the host machine's RAM. No scorecard field records it. -->

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

## Verdict: PASS on all three clauses

| Clause | Bar | Measured | Verdict |
|---|---|---|---|
| 1. Verified in a second process | < 500 ms | **55.97 ms** (median of 5 spawns) | PASS, 8.9x margin |
| 2. DAG nodes resolved | < 5% | **0.0239%** (60 of 250,582) | PASS |
| 3. Cache hits, single-wall recompute | > 90% | **99.9956%** geometry+property; **99.9984%** property-only | PASS |
| Mesh leaves genuinely present | not zero | **109,632** leaves, 43.8% of the DAG, 7 rewritten by the edit | YES |

<!-- numeral-ok: 500ms :: the exam's own bar, quoted in the Bar column. A
     threshold this bet is judged against, not a value it produces. -->
<!-- numeral-ok: 8.9x, 43.8% :: computed on the line from committed fields -
     8.9x is the 500 ms bar over verifyMedianMs 55.971, 43.8% is nodesMeshLeaves
     109,632 over nodesTotal 250,582. The scorecard stores the operands; the
     ratio is the row's own arithmetic. -->

Fixture: `tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc`,
177,465,622 bytes, 2,807,815 entities.

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

99.1% of the model's emitted geometry is represented in the DAG.

<!-- numeral-ok: 99.1% :: nodesMeshLeaves 109,632 over meshDataEntries 110,632,
     computed in the sentence from two committed fields. -->

### Construction versus verification

These are different quantities and only the second is what the exam bounds.

| Stage | Time |
|---|---|
| Parse | 2.80 s |
| Mesh | 8.08 s |
| DAG structure | 1.11 s |
| DAG build + full hash | 9.46 s |
| **One-time construction total** | **~21 s** |
| **Second-process verification** | **55.97 ms** |
| Whole verifier process incl. Node startup | 83.2 ms (also under the bar) |
| Bundle deserialize (timed outside the verify region) | 2.16 ms |
| Single-wall recompute | 5.39 ms (property) / 8.45 ms (geometry+property) |

Peak RSS: builder 2.47 GB, **verifier 71.5 MB**. The asymmetry is the point of
M1: constructing the proof is expensive and happens once; checking it is cheap
and happens everywhere.

<!-- numeral-ok: 21s :: the sum of the four stage timings in the table above
     (parseMs 2,796 + meshMs 8,082 + dagStructureMs 1,110 + dagBuildMs 9,463 =
     21.45 s), written as "~21 s". The scorecard stores the addends. -->

### Correctness checks that came with it

- **From-scratch cross-check:** rebuilding the DAG from nothing reproduces the
  incrementally-updated DAG hash for hash.
- **Tamper, two cases, both caught as `hash-mismatch`:** one `f32` byte flipped
  inside a mesh payload; one child hash altered in a storey the certificate
  claims is untouched.

## The question this bet was set to ask

**Does the data-plane number survive contact with mesh leaves? Yes.**
50.21 ms (g0 data-plane-only, re-run on this machine) to 55.97 ms mesh-bearing:
+11.5%. Inflating the edited wall's geometry 46x (24 to 1,106 vertices) moved
verification 53.9 to 56.0 ms. The reason is structural rather than lucky:
verification cost is dominated by re-hashing the 49 untouched-storey
`relationship` nodes, not by geometry payload size.

<!-- numeral-ok: 50.21ms, 11.5% :: 50.21 ms is g0's data-plane-only verify median
     re-run on this machine; g0 writes no scorecard, so it has no artifact here,
     and 11.5% is this paragraph's own comparison of it against 55.97 ms. -->
<!-- numeral-ok: 46x, 53.9, 49 :: 46x is examB's verticesMoved 1,106 over the
     wall's original 24, 53.9 ms is the pre-inflation verify median from the same
     variant run, and 49 is nodesStoreys 50 minus the one storey the edit
     touches. All three are computed in the sentence. -->

## Three caveats, including one that cuts against the headline

### 1. Mesh leaves made clause 2 arithmetically easier, and that is not banked

Adding mesh leaves moved the denominator 101,922 to 250,582 while resolved
nodes moved only 53 to 60. The percentage "improved" from 0.052% to 0.0239%
for reasons that have nothing to do with the system getting better. **The
invariant worth quoting is the count: 60 nodes.** Against the hardest honest
denominator (mesh leaves excluded) the figure is 0.0426%.

<!-- numeral-ok: 101,922, 0.052% :: g0/g1's own no-mesh node count and resolved
     share. Those demos write no scorecard, so both are quoted from their
     published runs and no artifact in this directory emits them. -->

### 2. Clauses 1 and 2 are properties of the CLAIM, not of the DAG

Measured counterfactual, same edit and same reads/writes, with
`subtree-untouched` claimed at **element** granularity instead of g0's
**storey** granularity:

| Claim granularity | Nodes resolved | % | Verify | Clause 1 | Clause 2 |
|---|---|---|---|---|---|
| storey (the exam) | 60 | 0.0239% | 55.97 ms | PASS | PASS |
| element | 60,805 | 24.27% | 899.0 ms | **FAIL** | **FAIL** |

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

<!-- numeral-ok: 465.4ms :: the verify timing the removed row carried, quoted
     only to show that it does NOT match the committed 453.5 ms. From an
     uncommitted run; it must stay unbacked. -->

The correction that removed it therefore overstated: the numbers were not
invented, they were unattributed. Both the row and this paragraph are the same
underlying defect - a figure with no committed artifact behind it - and the fix
in both directions is the artifact, which now exists.

### 3. g0/g1's DAG shape silently drops 36% of this model's geometry

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

| Shape | Nodes | Resolved % | Verify | Verdict | Artifact |
|---|---|---|---|---|---|
| contained + aggregated (this bet) | 250,582 | 0.0239% | 55.97 ms | PASS | `scorecard.json` |
| contained only (g0/g1) | 172,526 | 0.0348% | 60.86 ms | PASS | `scorecard-no-aggregates.json` |

The two verify medians come from separate runs on separate days, and run-to-run
spread on this machine is larger than the gap between those two cells, so the
difference between them says nothing about DAG shape. What the shape changes is
the denominator, which is the caveat's whole point. (An earlier revision gave
the first row as 56.2 ms - the *mean* of the five spawns - while every other
table here quoted the *median*, 55.97 ms. Corrected: the median is what
`scorecard.json` stores and what clause 1 is judged on.)

The exam passes either way and the resolved count is stable at 53-60 across
all three shapes; only the denominator moves. But **the published g0/g1 node
counts undercount geometry on any model that uses aggregation**, which is most
real curtain-walled buildings. That is a defect in the demos' traversal, not
in M1.

### Smaller caveats

- `reads` is empty because Holter's walls carry exactly one pset each (g0
  documented the same; duplex yields 9 reads).
- Trust root, kernel version and root `layerId` are placeholders, as in
  g0/g1/b35.
- Class-2 instanced templates excluded per g1 (zero on this fixture).
- Single machine, single fixture, warm cache.

## Reproducing

```bash
node scripts/moonshot/b45-m1-midterm/run.mjs              # ~35 s end to end
node scripts/moonshot/b45-m1-midterm/run.mjs --probe      # cheap parse+mesh dry run
node scripts/moonshot/b45-m1-midterm/run.mjs --no-aggregates  # the g0/g1 shape
```

Needs the Holter fixture (`node scripts/fetch-fixtures.mjs <path>`, and set
`FIXTURE_TIMEOUT_MS=600000` since the 60 s default aborts a 177 MB pull). The
runner self-execs with a raised heap; working bundles including the 36.5 MB
element-granularity sensitivity bundle go to a temp dir and are removed on
exit. Machine-readable results in `scorecard.json` and, for the g0/g1 shape,
`scorecard-no-aggregates.json`.

**The plain run does not touch the committed scorecard.** It writes to a temp
path and prints where. Re-blessing is `--write-scorecard`, and under
`--no-aggregates` that writes `scorecard-no-aggregates.json`, never
`scorecard.json`. An earlier revision always wrote `scorecard.json` next to the
script, which meant the reproduction command printed above destroyed the source
of truth this document is checked against - and the `--no-aggregates` line
destroyed it with figures from a different DAG shape.
