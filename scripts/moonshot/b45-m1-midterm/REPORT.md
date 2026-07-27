# B4.5: the M1 midterm, run as literally worded

Bet B4.5 of `docs/vision/moonshots-finishing-plan.md`. Executed 2026-07-27,
Apple M4 / 16 GB, warm fixture cache. Re-run and reproduced independently by
the orchestrator before commit.

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
| 1. Verified in a second process | < 500 ms | **56.5 ms** (median of 5 spawns) | PASS, 8.9x margin |
| 2. DAG nodes resolved | < 5% | **0.0239%** (60 of 250,582) | PASS |
| 3. Cache hits, single-wall recompute | > 90% | **99.9956%** geometry+property; **99.9984%** property-only | PASS |
| Mesh leaves genuinely present | not zero | **109,632** leaves, 43.7% of the DAG, 7 rewritten by the edit | YES |

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

### Construction versus verification

These are different quantities and only the second is what the exam bounds.

| Stage | Time |
|---|---|
| Parse | 2.87 s |
| Mesh | 8.60 s |
| DAG structure | 1.10 s |
| DAG build + full hash | 10.70 s |
| **One-time construction total** | **~23 s** |
| **Second-process verification** | **56.5 ms** |
| Whole verifier process incl. Node startup | 85.4 ms (also under the bar) |
| Bundle deserialize (timed outside the verify region) | 2.24 ms |
| Single-wall recompute | 5.5 ms (property) / 7.6 ms (geometry+property) |

Peak RSS: builder 2.20 GB, **verifier 71 MB**. The asymmetry is the point of
M1: constructing the proof is expensive and happens once; checking it is cheap
and happens everywhere.

### Correctness checks that came with it

- **From-scratch cross-check:** rebuilding the DAG from nothing reproduces the
  incrementally-updated DAG hash for hash.
- **Tamper, two cases, both caught as `hash-mismatch`:** one `f32` byte flipped
  inside a mesh payload; one child hash altered in a storey the certificate
  claims is untouched.

## The question this bet was set to ask

**Does the data-plane number survive contact with mesh leaves? Yes.**
50.21 ms (g0 data-plane-only, re-run on this machine) to 56.5 ms mesh-bearing:
+11.5%. Inflating the edited wall's geometry 46x (24 to 1,106 vertices) moved
verification 53.9 to 56.0 ms. The reason is structural rather than lucky:
verification cost is dominated by re-hashing the 49 untouched-storey
`relationship` nodes, not by geometry payload size.

## Three caveats, including one that cuts against the headline

### 1. Mesh leaves made clause 2 arithmetically easier, and that is not banked

Adding mesh leaves moved the denominator 101,922 to 250,582 while resolved
nodes moved only 53 to 60. The percentage "improved" from 0.052% to 0.0239%
for reasons that have nothing to do with the system getting better. **The
invariant worth quoting is the count: 60 nodes.** Against the hardest honest
denominator (mesh leaves excluded) the figure is 0.0426%.

### 2. Clauses 1 and 2 are properties of the CLAIM, not of the DAG

Measured counterfactual, same edit and same reads/writes, with
`subtree-untouched` claimed at **element** granularity instead of g0's
**storey** granularity:

| Claim granularity | Nodes resolved | % | Verify | Clause 1 | Clause 2 |
|---|---|---|---|---|---|
| storey (the exam) | 60 | 0.0239% | 56.5 ms | PASS | PASS |
| g0/g1 narrower shape | 21,777 | 12.62% | 465.4 ms | scrapes | **FAIL** |
| element | 60,805 | 24.27% | 907.6 ms | **FAIL** | **FAIL** |

Any future quote of "under 500 ms, under 5%" must carry the qualifier
**"for a storey-granularity claim"**. Without it the number is not reproducible
and is arguably not honest.

### 3. g0/g1's DAG shape silently drops 36% of this model's geometry

`g0` and `g1` reach elements only through `IfcRelContainedInSpatialStructure`.
On Holter that misses **40,028 of 110,632** MeshData entries: 27,427
`IfcMember` and 11,469 `IfcPlate`, i.e. the entire curtain-wall system, which
is aggregated into hosts rather than contained by storeys. This bet widened
the traversal to follow `IfcRelAggregates` as well and ran both shapes:

| Shape | Nodes | Resolved % | Verify | Verdict |
|---|---|---|---|---|
| contained + aggregated (this bet) | 250,582 | 0.0239% | 56.2 ms | PASS |
| contained only (g0/g1) | 172,526 | 0.0348% | 56.1 ms | PASS |

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
runner self-execs with a raised heap; working bundles including the 36 MB
element-granularity sensitivity bundle go to a temp dir and are removed on
exit. Machine-readable results in `scorecard.json`.
