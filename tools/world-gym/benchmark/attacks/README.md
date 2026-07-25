# CLEAN-TWIN-DIFF attack (G2 red-team experiment)

A real, scored adversarial submission that measures whether the World Gym
Benchmark v1.0 can be broken without reading any answer-key field. This is the
decisive experiment from the G2 review, run end to end through the real
`score.mjs` pipeline. **Result: it scores a perfect 1.0 aggregate on dev**,
above every committed anchor. The benchmark's v1.0 integrity story does not
hold against an adversary who reads the (open) generator.

## The attack model

The corpus generator is public and keyed only by the seed. Critically, in
`generator.mjs` the corruption draw lives on its own RNG stream (`${seed}:corrupt`),
independent of the family and parameter streams (`${seed}:family`,
`${seed}:params:*`). So for any evaluated seed an adversary can regenerate two
byte streams through the same public `generateModel` the spec invites
submitters to call:

```js
corruptedBytes = generateModel(seed, 'auto', { corruptRate: 0.3 }).content   // what a consumer receives
cleanBytes     = generateModel(seed, 'auto', { corruptRate: 0    }).content   // the CLEAN TWIN
```

Because corruption is on its own stream, `cleanBytes` is a byte-identical
building MINUS the planted corruption. A line-level diff of the two isolates
*exactly* the corruption. The attack:

1. **defect-detection** - diff clean vs corrupted line sets; each planted
   defect leaves a distinct structural fingerprint (see rule table below).
2. **quantity-estimation** - harvest the embedded `GymQuantities` from the
   CLEAN twin's bytes. `lib/quantities.mjs` guarantees the embedded per-element
   `GrossVolume` / `NetFloorArea` are the same numbers accumulated into
   `labels.totals`, so the clean twin reconstructs the quantity truth exactly -
   including the mass the `missing-quantities` defect deletes from the corrupted
   file.
3. **validity-triage** - count distinct detected defect types = reconstructed
   ordinal severity; because the diff is exact this equals planted severity.

The whole attack reads only `model.content` (the STEP bytes) from both models.
It never touches `.defects`, `.expected`, `.labels`, or `.params`.

## What it scored (dev, 1,000 models, real `score.mjs`)

| Row | defect-detection | quantity-estimation | validity-triage | aggregate |
|---|---|---|---|---|
| **clean-twin-diff (this attack)** | **1.000000** | **1.000000** | **1.000000** | **1.000000** |
| heuristic-text (anchor) | 1.000000 | 0.977655 | 1.000000 | 0.992552 |
| oracle-kernel (anchor) | 0.857143 | 0.977655 | 0.959139 | 0.931312 |
| always-clean (anchor) | 0 | 0 | 0.5 | 0.166667 |

(Anchors from `results/leaderboard-dev.json`.) Per-type defect F1 is 1.0 across
all seven types with zero false positives and zero false negatives; every
quantity key scores mean 1.0 including the 509/491 models where columns/beams or
rooms apply; triage concordance is 251058/251058 pairs, 0 ties.

**Verdict on the review's prediction.** The review predicted "aggregate ~1.0,
beating the oracle-kernel anchor's 0.9313." Confirmed, and stronger than
predicted: the attack reaches an *exact* 1.0, beating not only oracle-kernel
(0.9313) but also the near-saturated heuristic-text anchor (0.9926). No defect
type and no quantity resisted. The decisive lever over the anchors is
quantity-estimation: both anchors read the corrupted file and lose exactly the
mass `missing-quantities` deletes (0.977655); the clean twin recovers it (1.0).

## Which rules it stayed inside

BENCHMARK.md section 4 rule 1 forbids, for the evaluated seed, only reading
"the corruption layer's plant records" (`model.defects`) or "the generator's
internal ground truth" (`model.labels` / `model.expected`), and explicitly
permits "read/mesh/analyze the model bytes".

- The attack reads **only `model.content`** from both the corrupted model and
  the clean twin. No `.defects`, `.expected`, `.labels`, `.params`.
- Reading corrupted bytes is what a consumer does anyway (spec section 2:
  bytes "which the submitter regenerates locally or receives from the episode
  server").
- The clean twin is a **different model configuration** (`corruptRate: 0`);
  reading its bytes is "analyzing model bytes" of a model the attacker is free
  to generate.
- The label-MAPPING rules (which diff feature is which named defect) are
  derived from the **public `lib/corruption.mjs` source**, which any attacker
  can read because the repo is open - not from any per-seed label.

The gray zone the attack deliberately probes: the clean twin's embedded
quantities are numerically equal to the evaluated seed's `labels.totals`. The
attack derives them from BYTES (legal) rather than from the `labels` field
(forbidden), but the values are the same. Rule 1's letter (no `labels` read) is
satisfied; its spirit (don't reconstruct the answer key) is not. That gap is
the finding.

## Mapping rules: pure diff vs corruption-source knowledge

Every detection signal is a label-free byte diff. Only the human-readable
*name* attached to two of them leans on the open corruption source; none of the
detection needs any label field, and the clean twin supplies all
disambiguation for free.

| Defect | Label-free diff signal | Naming needs `corruption.mjs`? |
|---|---|---|
| clash-pair | corrupted has IFCFOOTING lines the twin lacks (a new element type appears) | Yes - "extra footings = clash injection" |
| degenerate-geometry | corrupted has strictly more IFCCOLUMN than the twin (real columns cancel; injected survive) | Yes - "surplus columns are zero-height degenerates" (the count diff alone is label-free) |
| duplicate-globalid | corrupted has a GlobalId on >1 entity; twin all-unique | No - self-describing |
| missing-site | twin has an IFCSITE; corrupted does not | No - self-describing |
| multiple-project | corrupted has >1 IFCPROJECT; twin has one | No - self-describing |
| dangling-ref | a reference undefined in corrupted whose target **never existed in the twin** (distinguishes it from the site-deletion dangling id, whose target DID exist in the twin) | No - the twin disambiguates; no hardcoded `#99999999` |
| missing-quantities | twin binds strictly more quantity sets than corrupted | No - self-describing |

The load-bearing insight: the clean twin is a **free oracle for "what
legitimately existed"**. It converts every deletion/insertion/rewrite defect
into a trivially visible diff and, for `dangling-ref`, cleanly separates the
injected dangling id from the missing-site side effect - the exact case the
kernel's `validate` cannot see and where oracle-kernel scores 0.

## Implications for v1.1 integrity options (factual, not prescriptive)

The spec decision is the maintainer's. The three options below are what would
actually deny this attack; each has a cost.

| Option | How it denies clean-twin-diff | Cost / trade-off |
|---|---|---|
| **Secret per-split generation salt** | Corruption (and ideally family/param) streams keyed by `hash(seed, SECRET_SALT)` known only to the hosted scorer. The adversary cannot regenerate the clean twin or the corrupted bytes without the salt. | Kills local self-scoring on dev/test (contradicts "score yourself locally as often as you like"); dev would need hosted scoring too, or a published dev-only salt (which re-opens dev). Breaks the "regenerable by anyone" design premise. |
| **Hosted episode bytes** | The scorer distributes only the corrupted bytes for evaluated seeds and never the generator; the clean twin is not reconstructable because `generateModel` / the salt is server-side. Matches the spec's already-stated "hidden-by-hosting" test posture, extended to remove the local generator path. | Requires the hosted leaderboard to actually exist (spec says human track "not yet live"). Dev loses local iteration unless a separate open dev corpus is accepted as sacrificial. |
| **Real-model substrate** | Replace procedural corruption with defects mined from real / hand-authored IFC where no clean twin exists and no closed-form regeneration is possible. | Loses known-by-construction ground truth and byte-determinism; labeling cost and answer-key drift return; the reward-channel determinism proofs no longer hold. |

Orthogonal hardening that shrinks the attack surface but does **not** close it:
adding geometric/organic defect families (element misalignment, unit-scale
errors, off-by-storey placement) that text scans cannot see - already noted in
BENCHMARK.md section 5. These raise the bar for the *heuristic-text* anchor but
not for clean-twin-diff, which diffs against a perfect twin regardless of defect
kind. Any organic defect on an independent RNG stream is still isolated by the
twin diff. The only structural fix is denying the adversary the clean twin
(salt or hosting), i.e. breaking the "clean twin is regenerable" premise the
attack rests on.

## Reproduce

```bash
# 1. Generate the attack submission (public interfaces only; ~5s for dev)
node tools/world-gym/benchmark/attacks/clean-twin-diff.mjs \
  --split dev --out <scratch>/attack-clean-twin-diff-dev.jsonl

# 2. Score it with the REAL pipeline (regenerates ground truth from seeds)
node tools/world-gym/benchmark/score.mjs \
  --submission <scratch>/attack-clean-twin-diff-dev.jsonl --split dev
```

The submission JSONL is a corpus-scale artifact; write it outside the repo
(the session scratchpad), like the baselines do.
