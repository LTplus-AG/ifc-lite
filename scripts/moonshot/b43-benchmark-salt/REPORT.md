# B4.3: the benchmark integrity salt, and whether it closes B2.2

Bet B4.3 of `docs/vision/moonshots-finishing-plan.md`. Apple M4.

Every measured figure below is transcribed from `scorecard.json` in this
directory and carries a `<!-- numeral-src: <token> :: <artifact>#<path> -->`
binding naming the single field it comes from; the bindings are collected at the
end of this file. Anything that is a bar, a threshold or an arithmetic identity
carries `numeral-ok` instead. Re-run with:

```bash
node scripts/moonshot/b43-benchmark-salt/run.mjs --out-dir <scratch>
```

**One figure in this document is a throughput measurement and moves with the
machine and its load** - the brute-force probe's sweep cost. A re-run that
changes `scorecard.json` must update the sentence quoting it, in the same
commit. Everything else is exact and reproduces to the digit.

## The question

Spec v1.1 withdrew the false "hidden-by-hosting" integrity claim and declared
the replacement: a per-split salt mixed into every RNG stream, delivered by a
hosted scorer. Neither half existed, so B2.2 stayed CONFIRMED-UNFIXED, and the
finishing plan recorded B4.3's exam - "`clean-twin-diff` scores at or below the
always-clean anchor on the reporting split" - as a clause that "can only be run
once hosting exists".

**That last part is wrong, and it is the reason this bet was runnable today.**
Hosting is how a submitter who cannot regenerate the split *receives* it. It is
not what makes the split unregenerable. The salt is. The two are separable, so
the exam runs in-process: stand up a salted reporting split, run the committed
attack against it WITHOUT the salt, and score through the real scorer. Running
the attack without the salt is not a simplification of the adversary's position,
it IS the adversary's position - hosting would never have handed them the salt
either.

## What was built

A salt that enters **every** stream: `{seed}:family`, `{seed}:params:{family}`,
`{seed}:corrupt`, and `guid:{seed}`.

The first three are what the spec names. The fourth is not, and leaving it out
would have left a hole: GlobalIds are the one stream printed verbatim into the
file, so an unsalted GUID stream stays a public exact readout of a salted model.
The attacker computes the sequence for the seed, compares it to the served
bytes, and every rooted entity the corruption layer DELETED shows up as a hole
in an otherwise contiguous sequence - a free `missing-site` detector needing
neither twin nor salt. It takes the salt.

**The salted path is keyed, not hashed, and that is not a stylistic choice.**
The obvious implementation - concatenate the salt into the existing stream key -
does not work. The unsalted engine is mulberry32 over an FNV-1a hash: whatever
you concatenate, the stream the generator consumes is one of a 32-bit space, and
the served bytes are a free verification oracle, because the parameter draws
become dimensions in the file. The probe in `scorecard.json` measures that sweep
against a real seed: the oracle identifies the true stream state exactly, with a
single match in a sampled window of two million candidates, at a rate that puts
the full sweep of the whole reporting split at about 656 core-hours. That is a
weekend on a spare machine, not a security barrier. Read that figure as an
order of magnitude: it is derived from a wall-clock throughput measurement, so
it legitimately moves with the machine and with the run, and the argument would
be identical at half or at double. So a salted stream is
HMAC-SHA256(salt, stream name) expanded into a 128-bit sfc32 state instead of a
mulberry32 one. The unsalted path is untouched, byte for byte.

Policy, in code rather than in configuration: `saltForSplit` returns the
unsalted universe for any split that is not the reporting split, whatever the
environment says, and the scorer refuses to run rather than silently ignore a
salt configured for the wrong one. Dev cannot be salted by anybody.

## The exam

Reporting split, 1,000 models, three published exam salts, every row produced
through the real submission round-trip (JSONL, `parseSubmission`,
`scoreSubmission`).

| Arm | What it is | Aggregate |
|---|---|---|
| attack, unsalted split | today's state | 1.000000 |
| **attack, salted split, no salt** | **the exam** | **0.315854 mean; 0.310826 low, 0.323077 high** |
| attack, salted split, WITH the salt | the control | 1.000000 |
| submission from an unrelated salt | uninformed reference | 0.312698 mean |
| always-clean | the anchor the clause names | 0.166667 |
| heuristic-text, unsalted | honest submitter, before | 0.992964 |
| heuristic-text, salted | honest submitter, after | 0.993272 mean |

Four readings, in the order they matter.

**First: the attack collapses, and the collapse is the salt's doing.** From an exact
1.000000 aggregate to 0.315854. Handed the salt, the same code returns to
1.000000 - so the harness works and the attack is not broken; it is defeated.
Its macro-F1 on defect-detection falls from 1.000000 to 0.092399, and the
statistic that says what actually happened: it reproduced the exact
seven-defect verdict vector of **every** corrupted model before, and of at most
0.009554 of them after.

**Second: what it collapses TO is "knows nothing", not "scores nothing".** A
submission built under an unrelated salt - well-formed, valid, and by
construction carrying no information about this split - scores 0.312698. The
attack's 0.315854 is that number. On a base-rate-free statistic the point is
sharper: the Matthews correlation between the attack's verdicts and the truth is
1.000000 before and 0.019940 after, the largest single value being 0.048437.
Against the analytic null for a correlation over this many models that is at
most 1.532 sigma, where the pre-salt value stands at 31.623.

**Third: the honest submitter is unharmed - which is the arm that decides whether
this is a fix or just damage.** `heuristic-text` reads the bytes it is served
and does not care which universe produced them: 0.992964 unsalted, 0.993272
salted. The salt removes the attacker's twin without removing anybody's model.
Before the salt the attack beat that honest baseline; after it, it is nowhere
near it.

**Fourth: dev is untouched and stays attackable.** `clean-twin-diff --split dev`
still scores an exact 1.000 through the real scorer. That is deliberate, is
documented, and is now enforced structurally rather than by policy.

## The exam clause fails as written, and it is the clause that is wrong

`clauseAsWritten: FAIL`. The attack's 0.315854 is above the always-clean anchor
of 0.166667, and no mechanism that leaves the attack *trying to score well*
could have made it otherwise.

`always-clean` is a degenerate constant predictor, and on two of the three tasks
the scoring math places it BELOW an information-free submission rather than at
it. Defect-detection is macro-F1, which scores zero for a submission that never
emits a positive, while one emitting positives at roughly the corpus rate earns
roughly that rate whether or not any of them is right. Quantity-estimation is
clamped relative error, which scores zero for a submission that answers zero,
while any plausible-magnitude guess earns partial credit. Only validity-triage
puts the two in the same place. So the clause asks the attack to score *worse
than knowing nothing*. That is reachable, but only by sabotage: validity-triage
is a concordance index where the constant anchor ties at 0.5, so a submission
that deliberately inverts its ranking scores 0.0 and passes the clause outright.
No submission *trying to score well* satisfies it, salted or not, which is the
opposite of the ordering an information-leak test needs.
The clause was written in the shape of "reduce the attacker to the floor" when
the property actually wanted is "reduce the attacker to ignorance", and those
are different points on this scoreboard.

Stated as a clause that CAN be satisfied and that this run satisfies: *the
attack retains no information about the salted reporting split - its score lies
inside the distribution of submissions built under unrelated salts, and its
correlation with the truth is zero within noise.* Amending the finishing plan's
wording is a gate act and has not been done here; this report records the
finding and the measurement.

### One honest wrinkle, not swept up

On one of the three exam salts the attack's aggregate sits at the top of its
null distribution, at 2.767 sigma over 24 samples. Three things are worth
stating plainly rather than leaving to the reader.

- The obvious explanation - that this submission simply emits more positive
  verdicts than the null samples, which macro-F1 pays for - was **tested and
  refuted**: the correlation between a null sample's positive count and its
  aggregate is weak and inconsistently signed across the three universes, and
  the attack does not out-emit the nulls. That probe is in the scorecard.
- The sigma itself is unstable. At eight null samples the same figure read
  4.255; at twenty-four it reads 2.767. A standard deviation estimated from a
  handful of samples is itself tens of percent of noise, which is exactly how a
  correlation of 0.048437 - one and a half sigma, nothing - can be made to look
  like four. This is why the verdict rests on the analytic null rather than an
  empirical one.
- The universe with the highest sigma is the universe where the attack achieves
  **zero** full-vector reconstructions: not one corrupted model has its complete
  seven-defect verdict vector recovered. Read that as what it is. Recovering all
  seven at once is a far stricter event than learning something about one of
  them, so zero full-vector hits does not by itself establish that no individual
  defect or quantity is inferable, and it is not offered as the security
  argument. The security conclusion rests on the MCC against the truth and on
  the position of the attack inside the unrelated-salt null distribution; this
  figure is corroborating, not load-bearing.

## What this settles, and what it does not

**Settled: the mechanism.** A salt that enters every stream closes the
clean-twin channel on the reporting split, does not touch the honest path, does
not touch dev, and leaves the unsalted corpus byte-identical - verified by
regenerating all three committed dev anchor rows and the dev split summary,
which reproduce exactly.

**Not settled: the trust model.** There is no hosted scorer, therefore no
deployment holds a salt, therefore the reporting split is still the public
universe and test rows are still self-reported. Nothing in this bet changes what
a test row is worth today. B2.2's *mechanism* is answered; B2.2's *delivery* is
the same hosting item B6.2 needs, and it is still not built.

The rotation and leak-response procedure ships with the mechanism rather than
after it (BENCHMARK.md section 1b), because a salt leak is silent and
retroactive: nothing observable changes when it happens, and every row already
published under it loses its property backwards in time. Rows carry the salt's
fingerprint so the affected set is identifiable, and `clean-twin-diff` stays
committed as the standing detector - if it ever scores near the honest baselines
against a live salted split instead of near the uninformed level, the salt is
out.

<!-- numeral-src: 1.000000 :: b43-benchmark-salt/scorecard.json#summary.attackBefore -->
<!-- numeral-src: 0.315854 :: b43-benchmark-salt/scorecard.json#summary.attackAfterMean -->
<!-- numeral-src: 0.310826 :: b43-benchmark-salt/scorecard.json#summary.attackAfterMin -->
<!-- numeral-src: 0.323077 :: b43-benchmark-salt/scorecard.json#summary.attackAfterMax -->
<!-- numeral-src: 0.166667 :: b43-benchmark-salt/scorecard.json#summary.alwaysCleanAnchor -->
<!-- numeral-src: 0.312698 :: b43-benchmark-salt/scorecard.json#summary.uninformedReferenceMean -->
<!-- numeral-src: 0.992964 :: b43-benchmark-salt/scorecard.json#summary.honestBaselineBefore -->
<!-- numeral-src: 0.993272 :: b43-benchmark-salt/scorecard.json#summary.honestBaselineAfterMean -->
<!-- numeral-src: 0.092399 :: b43-benchmark-salt/scorecard.json#summary.attackDefectF1AfterMean -->
<!-- numeral-src: 0.009554 :: b43-benchmark-salt/scorecard.json#summary.attackExactVerdictOnCorruptedAfterMax -->
<!-- numeral-src: 0.019940 :: b43-benchmark-salt/scorecard.json#summary.attackMccAfterMean -->
<!-- numeral-src: 0.048437 :: b43-benchmark-salt/scorecard.json#summary.attackMccAfterMax -->
<!-- numeral-src: 1.532 :: b43-benchmark-salt/scorecard.json#summary.attackMccAnalyticZMaxAbsAfter -->
<!-- numeral-src: 31.623 :: b43-benchmark-salt/scorecard.json#summary.attackMccAnalyticZBefore -->
<!-- numeral-src: 2.767 :: b43-benchmark-salt/scorecard.json#summary.nullDistributionMaxAbsZ -->
<!-- numeral-src: 24 :: b43-benchmark-salt/scorecard.json#summary.nullSamplesPerUniverse -->
<!-- numeral-src: 1,000 :: b43-benchmark-salt/scorecard.json#models -->
<!-- numeral-src: 656 :: b43-benchmark-salt/scorecard.json#bruteForce32Probe.fullSweepCoreHoursForSplit -->
<!-- numeral-src: 128 :: b43-benchmark-salt/scorecard.json#bruteForce32Probe.saltedPathStateBits -->
<!-- numeral-src: 32 :: b43-benchmark-salt/scorecard.json#bruteForce32Probe.unsaltedPathStateBits -->
<!-- numeral-ok: 4.255 :: the same statistic measured at an earlier, smaller null sample size, quoted in order to show that it MOVED. Binding it would defeat the point - the committed scorecard holds the twenty-four-sample value, and if this figure ever became backed the sentence would be wrong. -->
