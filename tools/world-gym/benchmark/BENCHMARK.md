# World Gym Benchmark - spec v1.2.0

The public benchmark face of the M2 World Gym (docs/vision/moonshots-execution-plan.md,
B2.2). One sentence: given procedurally generated IFC building models with
known-by-construction ground truth, score a system on detecting planted
defects, estimating quantities, and triaging models by severity - with the
answer key regenerable by anyone from seed arithmetic, and reference
baselines anchoring the leaderboard. That regenerability is the benchmark's
design premise and also, on the reporting split, its open integrity problem --
see section 1a before quoting a test score.

Version: `1.2.0` (`specVersion` in every submission and leaderboard row).
Any change to the constants, the generator's byte output, the task set, or
the scoring math bumps the version, and rows produced under versions that
differ in any of those are not numerically comparable. A version may also bump
without touching any of them, and both v1.1.0 and v1.2.0 are that case:

- **v1.1.0** changed no constant, no byte output, no task and no scoring math,
  only what the spec claims a test row is worth - it withdrew a false integrity
  claim and stated the real one (section 1a).
- **v1.2.0** implements the salt half of that claim (section 1a). Under the
  documented default - **no salt configured, which is every checkout and every
  CI run** - the generator's byte output is unchanged for every in-universe
  seed, verified against the committed anchors, so this bump too touches none
  of the four. What it changes is that the reporting split now HAS a mechanism
  that can be switched on, and that leaderboard rows carry `salted` and
  `saltId`.

So comparability splits in two here, and the two halves must not be conflated:

- **numerically comparable: yes, WITHIN a universe.** v1.0, v1.1 and unsalted
  v1.2 share a seed universe, bytes, tasks and scoring math, so their scores
  measure the same thing and may be read side by side. A **salted** row is a
  different model universe and is comparable only with rows carrying the same
  `saltId` - which is why the field exists.
- **comparable in trust: no.** A v1.0 *test* row was reported under a claimed
  integrity property that did not exist (section 1a); a v1.1 test row is
  reported as self-reported, with no integrity property claimed at all; an
  unsalted v1.2 test row is the same self-reported thing. The numbers line up;
  what they are worth does not, and no later version can retroactively give a
  v1.0 test row the trust its version asserted.

Dev rows are untouched by the second point: dev carried no integrity claim
under any version and still carries none.

## 1. Model universe and splits

The benchmark is exactly seeds `0..9999` of the World Gym generator
(`tools/world-gym/generator.mjs`), family `auto`, corruption rate `0.3`:

```js
generateModel(seed, 'auto', { corruptRate: 0.3 })  // byte-deterministic
```

Splits are defined by seed arithmetic, nothing else:

| Split | Rule | Size |
|---|---|---|
| train | `seed % 10 <= 7` | 8,000 |
| dev   | `seed % 10 == 8` | 1,000 |
| test  | `seed % 10 == 9` | 1,000 |

There is no dataset download. A model, its bytes, its planted defects, its
quantities - all are pure functions of the seed **and of the split's salt, if
it has one** (see the determinism section of `../README.md`). We do not publish
an answer-key file for any split, because while the generator is unsalted -
which is every split in any checkout, see section 1a - such a file would be
security theater: anyone can regenerate it. Read "anyone can regenerate it" as
scoped to that unsalted state. Once the reporting split is salted its answer key
stops being regenerable by anyone, and it stays unpublished for the opposite
reason: it is then held by the scorer and publishing it would destroy the
property.

### 1a. Integrity model (v1.2). Read this before quoting a score.

**v1.0 claimed the test split was "hidden-by-hosting". That claim was false and
is withdrawn.** `attacks/clean-twin-diff.mjs` scores an exact **1.000 aggregate**
through the real scorer, above all three committed anchors, while reading only
`model.content` and touching no answer-key field. The attack is not a rule
violation; it is a consequence of the design:

- splits are defined by seed arithmetic alone (`seed % 10`), so **every test
  seed is public** - there is no seed list to withhold;
- `generateModel(seed, family, opts)` takes **no secret**, so anyone can
  regenerate any model;
- corruption is drawn from its own `${seed}:corrupt` RNG stream, independent of
  the family and param streams, so `corruptRate: 0` yields a byte-identical
  **clean twin** and a line diff isolates every planted defect exactly.

Hosting the episode bytes does not fix this, and it is worth being explicit
about why, because it is the intuitive fix: the attacker never needed the bytes.
Knowing the seed and owning the generator, they produce both twins locally. A
hosted server withholds only what is freely reconstructible.

**What actually closes it is a secret that enters generation.** v1.1 declared
the reporting split's integrity model as *hidden-by-secret-salt, delivered by
hosting*, and the two halves are not alternatives:

1. a per-split salt, held only by the scoring service, mixed into **every** RNG
   stream - `family`, `params`, `corrupt` and the GlobalId stream. Salting only
   the corruption stream is insufficient: the clean twin stays computable and
   diffs against the served bytes. The salt is rotatable per split, so a leak is
   a dated, recoverable event rather than a silent permanent one;
2. a hosted scorer to deliver the salted bytes, since a submitter who cannot
   regenerate the split must receive it. This is the same server B6.2 requires,
   not a second mechanism.

**Status in v1.2, stated so no reader has to infer it: half 1 is implemented and
measured; half 2 does not exist.** The salt is real code
(`../lib/salt.mjs`, `generateModel(seed, family, { salt })`,
`splits.mjs#saltForSplit`, threaded through ground-truth regeneration and the
scorer). No deployment configures one, because there is no deployment. So:

- the **mechanism** is settled. It was measured, on the reporting split,
  through the real scorer, by standing a salted split up locally and running the
  committed attack against it without the salt - which is exactly the adversary's
  position, since hosting would never have handed them the salt either. The
  attack falls from an exact 1.000 aggregate to the level of a submission built
  under an unrelated salt, its macro-F1 on defect-detection falls from 1.000 to
  under a tenth, and it reconstructs the exact defect vector of at most one
  corrupted model in a hundred instead of all of them. Handed the salt it
  returns to 1.000, so it is the secret doing the work. An honest submitter
  reading the served bytes is unaffected. Numbers, arms and controls:
  `scripts/moonshot/b43-benchmark-salt/`.
- the **trust model** is not in force. Without a hosted scorer there is no
  channel that delivers salted bytes to a submitter and no scorer that holds a
  salt, so **today's test rows remain self-reported and carry no integrity
  property**, exactly as under v1.1. A test row is trustworthy when a scorer
  holds the salt, not when the repo contains the ability to hold one.

One finding from that measurement belongs in the spec rather than only in the
report, because it constrains any future re-implementation: **the exam clause as
written does not test for an information leak.** The clause says
`clean-twin-diff` must score "at or below the always-clean anchor".
`always-clean` is a degenerate constant predictor, and both defect-detection
(macro-F1, which gives 0 to a submission that never emits a positive) and
quantity-estimation (relative error, which gives 0 to a submission that answers
0) score it BELOW an information-free submission rather than at it. So the
clause asks the attack to score *worse than knowing nothing*.

That is not impossible - it is reachable, but only by sabotage, which is the
actual defect. The submission contract accepts any finite triage value, and
validity-triage is a concordance index where the constant anchor ties at 0.5, so
a submission that deliberately INVERTS its ranking scores 0.0 and passes the
clause outright (measured directly against `scoreValidityTriage`). The clause is
therefore satisfiable by a submission that has thrown information away, and
unreachable for any attack that is trying to score well - which is the opposite
of the ordering an information-leak test needs. The property that was actually
wanted, and that is measured, is: **the
attack retains no information about the salted split** - its score is inside the
distribution of submissions built under unrelated salts, and its correlation
with the truth is zero within noise on a base-rate-free statistic. Amending the
clause is a gate act for the finishing plan, not something this spec does.

- **dev is open and attackable by design.** Score yourself locally as often as
  you like (`score.mjs --split dev`). `clean-twin-diff` works on dev and will
  keep working; that is deliberate, and dev numbers carry no integrity claim
  whatsoever. This is enforced in code, not by configuration:
  `saltForSplit` returns the unsalted universe for any split that is not the
  reporting split, whatever the environment says, and the scorer refuses to run
  rather than silently ignore a salt configured for the wrong split.
- **test is the reporting split**, and the only split a salt may apply to.
  Today: self-reported, no integrity property, see above. With a scorer: salted
  and server-side, the only channel that carries trust against an adversary.
- **train is where systems may learn**; training on dev/test seeds is
  contamination and disqualifies a row (enforceable only for hosted rows).

### 1b. Salt lifecycle and rotation. Write this down before you need it.

A salt leak is silent and retroactive: nothing observable changes at the moment
it happens, and every row scored under it - including rows already published -
loses its property backwards in time. That asymmetry is the whole reason the
salt is per-split and rotatable, and the reason this procedure is written next
to the implementation instead of being left for the incident.

**Generating one.** 32 bytes from a CSPRNG, hex-encoded:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

**That format is enforced, not suggested.** A weak salt silently produces a weak
split, which looks exactly like protection and is not - the same failure shape
as a check that cannot fail - so a bad one is a refusal (`SaltFormatError`)
rather than a warning. Two tiers, both in `lib/salt.mjs`:

- every salt anywhere must be printable ASCII with no whitespace and must carry
  a contiguous run of at least **32 lowercase hex characters** (128 bits of
  machine-generated material, with a repetition guard so `000...0` does not
  qualify). A human-chosen value like `benchmark-secret` is defeated by the very
  oracle the salt exists to stop - guess, regenerate, compare to the bytes you
  were served - so it is rejected outright. A readable label around the random
  run is fine, which is how the published exam salts of
  `scripts/moonshot/b43-benchmark-salt/` are spelled.
- a **deployment** salt - the one `WORLD_GYM_SALT_TEST` carries into
  `saltForSplit` - must additionally be *exactly* 64 lowercase hex characters,
  i.e. the output of the command above and nothing else. That second tier exists
  for the failure the first cannot catch: someone pasting a *published* exam
  salt into a production scorer.

This is a shape check, not an entropy oracle. It catches the misconfiguration
that actually happens - a memorable phrase, a repeated character, a truncated
paste - and cannot catch someone who types 64 hex characters out of their head.
Randomness is guaranteed by using the command above; the check is what makes a
deviation from it visible.

**Holding one.** The salt lives in the scoring service's environment as
`WORLD_GYM_SALT_TEST` and nowhere else - not in the repo, not in a config file,
not in a leaderboard row, not in a log line, and above all **never in a command
line**. A value in argv is visible in `ps`, in `/proc/<pid>/cmdline`, in the
invoking shell's history file and in the command echo of every CI runner, i.e.
to every other user on the machine and to anything that scrapes a process table
- so the tools here **refuse `--salt <value>` outright**, with a non-zero exit,
rather than accepting it or (worse) ignoring it and running unsalted while the
caller believes otherwise. The two supported forms are:

```bash
node tools/world-gym/generator.mjs --seed 9 --salt-env WORLD_GYM_SALT_TEST --out model.ifc
node tools/world-gym/generator.mjs --seed 9 --salt-file /path/to/salt   --out model.ifc
```

`--salt-file` requires mode 600 - a salt file another user on the box can read
is the same leak, only quieter - and never echoes the contents, only the path.
Both forms also refuse an argument that *looks like salt material*, because a
64-hex secret is a perfectly valid variable name and a perfectly valid path, so
"you pasted the value where the name goes" has to be caught by shape.

Tools print the **fingerprint** (`saltId`, a truncated HMAC over a fixed label)
so a row can say which universe it belongs to without revealing the universe. No
error message, log line, submission file, leaderboard row or scorecard in this
tree contains a salt value, and the CLI error paths additionally scrub the
resolved salt out of anything they are about to write, so that a throw from
somewhere else cannot carry it out. `determinism-check.mjs` asserts all of this
on every run.

**What counts as a leak.** Any of: the value appearing in a **process listing or
a shell history** (the reason for the argv rules above), a log, a CI transcript,
an error message, a screenshot or a support ticket; a world- or group-readable
salt file; a machine holding it being compromised; a person holding it leaving
the trust boundary; or - the one that gets missed - a submitter scoring
anomalously well in a way that only twin reconstruction explains.
`clean-twin-diff` stays committed as the standing regression precisely so that
last case has a detector: re-run it against the live salted split, and if it
scores near the honest baselines instead of near the uninformed level, the salt
is out.

**Rotating.** Rotation is cheap by construction: nothing is stored, so there is
no dataset to rebuild. The universe is a pure function of the salt.

1. Generate a new salt. Do not delete the old one yet - you need it to identify
   affected rows.
2. Record both fingerprints, the retirement timestamp and the reason. The
   fingerprints, not the salts.
3. Set the new value in the scorer's environment and restart it. Every
   subsequent scoring run regenerates truth in the new universe automatically;
   there is no migration step and no cache to invalidate.
4. Re-run the reference baselines on the reporting split under the new salt.
   Anchors are universe-specific: an anchor from the retired salt describes a
   different corpus.
5. Mark every leaderboard row carrying the retired `saltId` as **scored under a
   retired salt**. Do not silently delete them and do not silently keep them:
   they are still valid measurements of a universe whose secrecy ended, and the
   honest label is exactly that. Rows may be re-run under the new salt on
   request; a re-run is a new row, not an edit.
6. Re-run `attacks/clean-twin-diff.mjs` against the new universe as the
   post-rotation regression.

**What rotation does not fix.** It does not restore trust in rows already
scored under the leaked salt - nothing does, which is why step 5 labels rather
than launders them - and it does not help if the leak is of the generator's
*outputs* rather than the salt (a submitter who obtained the served bytes for
seeds they were never assigned has contaminated themselves, and that is a
contamination question under rule 2, not a salt question).

## 2. Tasks

All three tasks read the same input (the model bytes for a seed, which the
submitter regenerates locally or receives from the episode server) and are
scored against generation-time ground truth - never against any checker's
output, so no checker bug can leak into the answer key.

### 2.1 defect-detection

Per model, a boolean verdict for each of the 7 defect types
(`clash-pair`, `degenerate-geometry`, `duplicate-globalid`, `missing-site`,
`multiple-project`, `dangling-ref`, `missing-quantities`). Ground truth is
the corruption layer's plant-time records. Clean models have all-false truth.

Score: **macro-F1** over the 7 types. Per type, F1 = 2TP/(2TP+FP+FN) over
all models of the split; a type with TP+FP+FN = 0 scores 1. Task score =
mean of the 7 per-type F1 values. (The always-clean baseline scores 0 here
by construction: it never produces a true positive.)

### 2.2 quantity-estimation

Per model, predict 5 quantity totals in metric units:
`wallGrossVolume`, `slabGrossVolume`, `columnGrossVolume`,
`beamGrossVolume` (m3), `roomNetFloorArea` (m2). Ground truth is the exact
numbers used to author the geometry (the kernel quantities), NOT what
survives in the file - the `missing-quantities` defect deletes bindings from
the bytes, but the geometry still has those volumes and a system that meshes
the file can recover them.

Score: per model, over the keys whose truth is > 0 (families do not share
all keys - `office` has no columns/beams, `frame` has no rooms; predict 0
for non-applicable keys, they are never scored):
`mean_k max(0, 1 - |pred - truth| / truth)`; task score = mean over models.

### 2.3 validity-triage

Per model, one real number: higher = more defective. Ground truth severity
is ordinal: the number of distinct planted defect types (0 clean, 1-3
corrupted). Score: **concordance index** - over all model pairs with
different truth severity, count 1 when the predicted ordering agrees, 0.5
when the predictions tie, 0 otherwise; task score = mean. 0.5 is
uninformative, 1 is a perfect ranking.

### Aggregate

Unweighted mean of the three task scores. Reported only for submissions
covering all three tasks; partial submissions get per-task scores and a
null aggregate.

## 3. Submission format

One JSONL file. First line is a header, then one line per seed of the split
(any order, every seed exactly once):

```jsonl
{"type":"header","benchmark":"ifc-lite-world-gym","specVersion":"1.2.0","split":"dev","name":"my-method","tasks":["defect-detection","quantity-estimation","validity-triage"]}
{"seed":8,"defects":{"clash-pair":false,"degenerate-geometry":false,"duplicate-globalid":false,"missing-site":false,"multiple-project":false,"dangling-ref":false,"missing-quantities":false},"quantities":{"wallGrossVolume":44.7,"slabGrossVolume":35.2,"columnGrossVolume":0,"beamGrossVolume":0,"roomNetFloorArea":122.1},"triage":0}
```

`tasks` may be any non-empty subset; each model line must carry exactly the
fields the declared tasks need (`defects` with all 7 booleans / `quantities`
with all 5 non-negative finite numbers / `triage` finite number).

Validate and score:

```bash
node tools/world-gym/benchmark/score.mjs --submission sub.jsonl --split dev --validate-only
node tools/world-gym/benchmark/score.mjs --submission sub.jsonl --split dev --out row.json
```

The scorer regenerates ground truth from seeds on every run (dev: ~1,000
generations, seconds) and emits a deterministic leaderboard-row JSON - same
submission in, byte-identical row out.

## 4. Rules

1. Systems may use anything at inference time EXCEPT the corruption layer's
   plant records or the generator's internal ground truth for the evaluated
   seed (i.e. you may read/mesh/analyze the model bytes; you may not call
   `generateModel` on the evaluated seed and read `model.defects` - that is
   the answer key). Running ifc-lite's own checks is allowed - that is what
   the `oracle-kernel` baseline does, and beating it is the point.
2. Training/tuning on `train` seeds is expected; any use of dev/test seed
   ground truth during training is contamination.
3. Report the spec version with every row. Rows never share a leaderboard
   across versions that differ in seed universe, byte output, task set or
   scoring math. v1.0 and v1.1 differ in none of those and are the one
   documented exception (see the version note at the top of this file) -
   which is why the committed anchor rows still read `1.0.0`. The integrity
   claim never carries across a version, exception or not.
4. Self-reported test rows must state "self-reported", and today every test
   row is one. The trusted channel is hosted scoring over a SALTED split
   (human track). The salt exists as of v1.2 and is measured (section 1a); the
   hosting does not, so no trusted channel is running. Hosting without the salt
   would not have been one either - see section 1a.
5. A row scored under a salt records its `saltId`, and rows with different
   `saltId` values are different model universes: do not rank them against each
   other. `saltId: null` means the public universe.

## 5. Reference baselines (leaderboard anchors)

`baselines.mjs` produces three rows, committed under `results/`, that make
external numbers interpretable:

- **always-clean**: no defects, zero quantities, constant triage. The floor.
- **heuristic-text**: cheap text/structural signals only (entity counts,
  duplicate-GUID scan, reference-integrity scan, depth-0 extrusion scan,
  qset-binding ratio check, regex harvest of embedded quantity values). No
  geometry kernel, no schema engine.
- **oracle-kernel**: the kernel's own in-process schema/clash/quantity
  checks mapped to verdicts - the oracle-ish upper bound.

The committed rows under `results/` carry `"specVersion": "1.0.0"` and keep
it. That is the version they were produced and scored under, and rewriting the
field would assert a scoring run that never happened. They remain the valid
anchors for a v1.2 number **on the unsalted universe**: v1.1 changed only the
`SPEC_VERSION` constant, and v1.2 leaves unsalted generation byte-identical
(verified against these rows), so re-running `baselines.mjs` with no salt
configured emits the same scores - with `1.2.0` in the version field and the
two new `salted` / `saltId` fields, which is the whole diff. They are dev rows,
so nothing about the withdrawn test-split claim attaches to them, and dev is
never salted.

Two honest and load-bearing observations from the dev-split anchors
(numbers in `results/leaderboard-dev.json`):

1. **heuristic-text outscores oracle-kernel on defect-detection.** The v1
   corruption layer plants mostly text-level defects, and one of them
   (`dangling-ref`) is invisible to the kernel's validate while being
   trivial for a reference-integrity text scan. Consequences: (a) the
   defect-detection task is near-saturated by pattern-matching for THIS
   corpus version - external submissions should be read primarily on
   quantity-estimation (where geometry understanding is required to beat
   text harvesting on corrupted models) and on robustness/generalization;
   (b) spec v1.1 should add geometric/organic defect families (element
   misalignment, unit-scale errors, off-by-storey placement) that text scans
   cannot see, plus a validate reference-integrity rule upstream.
2. **Neither baseline reaches 1.0 on quantity-estimation.** Both read the
   quantity values embedded in the bytes, so both lose exactly the truth
   that `missing-quantities` models withhold; recovering it requires actual
   geometry reasoning. That gap is deliberate headroom.

## 6. Episode access for RL-style consumers

`ifc-lite gym --seed <n>` serves benchmark episodes over the existing
reset/step/reward JSONL protocol without the consumer touching generator
internals; mid-session `{"type":"reset","seed":<n>}` swaps to a new episode.
See `../README.md` ("Benchmark quickstart") and `ifc-lite help` for the
protocol.

## 7. Files

```text
../lib/salt.mjs       the per-split salt: normalization, KDF, fingerprint (1a/1b)
benchmark/
  BENCHMARK.md        this spec (versioned)
  splits.mjs          constants + split arithmetic + saltForSplit (the normative universe)
  ground-truth.mjs    per-seed answer-key regeneration (generation-time labels only)
  submission.mjs      submission JSONL parser + validator
  score.mjs           scoring harness CLI (per-task + aggregate + row emission)
  baselines.mjs       the three reference baselines (submission round-trip incl. validator)
  results/            committed anchor rows + split summaries (small JSONs)
  attacks/            committed adversarial submissions, kept as regressions
```

The salt's own evidence - the before/after measurement, the with-salt control,
the uninformed-reference distribution and the honest-baseline arm - lives in
`scripts/moonshot/b43-benchmark-salt/` and is re-runnable in about a minute.
