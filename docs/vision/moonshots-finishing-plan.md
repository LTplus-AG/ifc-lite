# Moonshots finishing plan: Phase 4 to 6

Written 2026-07-26. Third document in the set, after
[moonshots-tech.md](./moonshots-tech.md) (what and why) and
[moonshots-execution-plan.md](./moonshots-execution-plan.md) (how, in what order).
That second document's calendar is now fiction: it dated Phase 3 to Mar-Jun 2027
and three of its five Phase 3 bets landed in July 2026. This document does three
things the other two cannot:

1. Corrects the record on what Phase 0 to 3 actually delivered, including two
   bets that were never built and one exam that was met literally while being
   lost economically.
2. Defines what "finished" means, because the program has been chasing one of
   three possible finish lines and treating it as all three.
3. Plans Phases 4 to 6 to the end, with pre-committed gates, in the same
   framework, plus the instruments the program's own red team showed were
   missing.

Nothing here is a retreat from the thesis. The thesis (neural systems propose,
the kernel disposes) survived Phase 2 and 3 intact. What did not survive is the
assumption that self-authored harnesses grading self-generated distributions can
finish the job.

---

## 1. Correcting the record

### 1.1 Phase 3 delivered three of five bets

| Bet | Status | Evidence |
|---|---|---|
| B3.1 encrypted provable multiplayer (M4 final) | **NOT BUILT** | no artifact anywhere in `scripts/`, `tools/`, or `packages/collab` |
| B3.2 scan-to-parametric + world-model import (M5 final) | **NOT BUILT** | same |
| B3.3 proof-carrying optimization chain (M3 final, partial) | delivered | `scripts/moonshot/diff-spike/`, chain format v2 merged as #1888 |
| B3.4 kernel stage on GPU with manifest parity (M6c final) | delivered, split verdict | `scripts/moonshot/b34-kernel-stage/REPORT.md` |
| B3.5 the integrated jaw-drop | delivered | `scripts/moonshot/b35-demo/`, five acts, seeded, 7.5 s |

So the two hardest final exams in the program, both requiring contact with
something outside the parametric sandbox (encryption across three real clients;
a real scanned room), were skipped in favour of the three that could be built
from existing parts. That is a survivorship pattern, not a schedule accident,
and it is the single most important fact in this document.

### 1.2 The G2 red-team scorecard

The adversarial review (`reviews/g2-red-team-2026-07-24.md`) raised four
findings plus one structural criticism. Status as of today:

| Finding | Status | Detail |
|---|---|---|
| B2.3 (M5): exam cannot measure its claim | **CLOSED** | tier-2 exam 2026-07-25 implements all five required changes (rubric headroom proven at mean 0.847 spread 0 to 1; five validator rules held out of prompts; three budget-matched arms at k=3; 23 briefs including 3 infeasible; anti-laundering intent-fidelity multiplier), then replicated on fresh samples |
| B2.2 (M2): answer key is publicly computable | **CONFIRMED, UNFIXED** | `benchmark/attacks/clean-twin-diff.mjs` scores an exact **1.000 aggregate on dev** through the real scorer, above both anchors; spec still `1.0.0`, integrity model unchanged (correctly parked as a maintainer decision) |
| B2.1 (M4): spatial predicate unfalsifiable | **OPEN** | `merge-model.ts` still applies ops purely per-node; spatial-structure edits explicitly outside the v0 vocabulary; no real-trace replay |
| B2.4 (M3): gradients never touch the kernel | **OPEN and widened** | B3.3 built more certificate infrastructure on the parametric path instead of attacking adjoints through CSG |
| Section 3: nothing verifies against the external world | **OPEN** | every result in the program is still measured on distributions the program authored |

<!-- numeral-src: 0.847 :: m5-constrained-decoding/results-tier2.json#headroom.meanQuality -->
<!-- numeral-src: 1.000 :: none - the clean-twin-diff aggregate, produced by
     benchmark/attacks/clean-twin-diff.mjs against the live scorer. No committed
     artifact stores it. -->

The M5 outcome deserves its honest headline, because it is the template for how
this program should behave: the tier-2 verdict is **less** flattering than
tier-1's, not more. The midterm's "wide margin" clause is **not met** for
feasible generation under either run: run 1 (23 briefs) put the paired margin at
+0.008 [0.000, 0.025] against validator-filtered best-of-3 and exactly 0.000
against unfiltered; the fresh-sample replication put both at +0.05 [0, 0.15],
a CI that still straddles zero. What did replicate, exactly, on independent
samples: infeasibility handling at 3/3 versus 1/3 for both baselines, and zero
laundering. Run 1 also showed 6/6 recovery when held-out rules bite; the
replication surfaced one repair-cap exhaustion (T2-10), so the recovery claim is
"6/6 in one run, with a known cap-sensitivity" rather than unconditional.
T2-F3, infeasible only under a rule that appears in no prompt, is a clean
structural demonstration that the kernel carries unpromptable information. That
is a real result and a narrower one than the exam asked for.

### 1.3 M6c: met literally, lost economically

B3.4's own report is unambiguous and needs to be read into the program record
rather than left inside a bet directory:

- Versus the equivalent exact CPU evaluation of the same stage, on real
  extracted workloads with model-wide batching: **5.8x to 25.1x. Exam clause
  met.** Sign-for-sign manifest parity exact.
- Versus the actual production CPU path (native Shewchuk adaptive, the code
  that really runs): **0.05x to 0.20x. The GPU loses on every model,
  including asymptotically.** Per-tuple asymptote is roughly 80 ns on GPU
  against 15 ns native, and shipping only the degenerate subset cannot win
  (65 ns versus 80 ns) because you cannot identify the subset without running
  the filter anyway.

  <!-- numeral-src: 5.8x :: b34-kernel-stage/report.b34.json#models[0].speedups.gpuWholeVsCpuBigInt -->
  <!-- numeral-src: 25.1x :: b34-kernel-stage/report.b34.json#models[4].speedups.gpuWholeVsCpuBigInt -->
  <!-- numeral-src: 0.05x :: b34-kernel-stage/report.b34.json#models[2].speedups.gpuWholeVsNativeShewchuk -->
  <!-- numeral-src: 0.8x :: b34-kernel-stage/report.b34.json#models[1].speedups.gpuPerOpVsCpuBigInt -->
  <!-- numeral-src: 1.1x :: b34-kernel-stage/report.b34.json#models[0].speedups.gpuPerOpVsCpuBigInt -->
  <!-- numeral-src: 0.20x :: none - endpoint of a RANGE against the production
       adaptive-Shewchuk path. The per-model maximum this file emits is
       models[4].speedups.gpuWholeVsNativeShewchuk, and it is not 0.20x; the
       range endpoint was computed outside the artifact and stays unbacked
       until B3.4 emits it. -->
- Per-op dispatch, which is the batch shape today's kernel structure naturally
  produces, sinks to 0.8x to 1.1x on three of five models.

<!-- numeral-src: 2.9x, 4.2x :: none - M6b's threaded-CSG speedup range, quoted
     from moonshots-tech.md. It was measured before this program committed any
     artifact for it, and nothing in scripts/moonshot/ emits it. -->

The honest reading: the B2.5 library beats every exact-tier CPU evaluation it is
put against, and does not beat a well-engineered adaptive filter at this stage's
realized arithmetic. This is a **publishable negative result of the kind the
execution plan explicitly pre-authorised** ("Below that, publish the negative
result; it is still a contribution"), and it has a consequence the plan also
anticipated: M3's per-step projection budget must be re-planned around CPU
threading only. M6b (threaded CSG, 2.9x to 4.2x, still documented as "validated
by measurement, not yet wired into production") therefore stops being a nice
lever and becomes the critical path for M3's interactivity claim.

### 1.4 Standing evidence: zero

Thirteen CI workflows exist. None runs anything under `scripts/moonshot/`
(verified 2026-07-27: the sole grep hit in `release.yml` is a comment about SLSA
provenance, not this program's package). The only moonshot code with automated
protection is `@ifc-lite/provenance`'s own vitest suite. Every headline number in
Phases 1 to 3 is therefore a measurement taken once, on one machine, on one day,
with no tripwire if a kernel change invalidates it. The b35 demo is seeded such
that every number outside one marked block is a pure function of seed 20260724,
which makes it an ideal golden-output regression test that nobody is running.

<!-- numeral-src: 20260724 :: b35-demo/demo-report.json#deterministic.masterSeed -->

### 1.5 Honest TRL, revised

| Moonshot | Plan's TRL (2026-07-24) | Actual today | Why the change |
|---|---|---|---|
| M1 proof-carrying buildings | 3 | **4** | spec + library + memoized engine + verified demos, but zero callers outside `scripts/moonshot/`; package is `private`, `0.0.1` |
| M2 world gym | 2-3 | **5** | 100k corpus, five reward channels, `ifc-lite gym` shipped in the CLI; benchmark integrity broken by its own attack |
| M3 differentiable buildings | 1-2 | **3** | closed-form gradients validated and certified end to end; kernel adjoints and the projection operator untouched |
| M4 provable merges | 3 | **3** | strong battery, but the spatial half of the predicate has never produced a true conflict, so the contract is partly unfalsified |
| M5 grounding compiler | 2 | **4** | two-tier exam with held-out rules and replication; no real input modality, no scan, no world-model import |
| M6a wasm wide-arithmetic | 6 | **6** | CI lane exists (`wide-arithmetic.yml`); still waiting on the browser flag |
| M6b threaded CSG | 5 | **5** | unchanged, and now on the critical path |
| M6c exact predicates on GPU | 1 | **4, with a negative economic verdict** | real stage, real parity, loses to the production filter |

The column spans **TRL 3 to 6**, not a flat band: M6a is already 6, M3 and M4
are still 3, and the modal value is 4. Five of the eight moved up and none moved
down. That is a genuinely strong six-month position, with one shipped surface,
and it is not TRL 7 anywhere - which is what "finished" would require.

---

## 2. Framework: four instruments, plus three

The original four stay: **Heilmeier catechism** as the planning unit, **DARPA
phases with TRL and go/no-go gates**, **Shape Up 6-week cycles with a betting
table**, **X-style pre-committed kill criteria**. They worked. Phases 0 to 3
produced falsifiable exams and the program failed several of them out loud,
which is the whole point.

Three instruments are added, each answering a failure mode the last three phases
demonstrated rather than predicted:

**5. Standing evidence (answers: results decay silently).** No result counts as
held unless a scheduled job re-derives it. A number measured once is a claim
about the past. This is the cheapest instrument in the program and its absence
is currently the largest single risk to everything already achieved.

**6. External validity as a gate clause, not a caveat (answers: the program
grades its own distributions).** Every remaining exam gets a paired clause
measured on data the program did not author: real IFC from other tools, real
edit traces, briefs written by someone else. A result that has not survived
contact with foreign data is reported at half strength.

**7. Standing adversarial review (answers: survivorship bias).** The G2 review
was the highest-yield artifact the program produced per hour spent, and it was
commissioned once. Every gate from G4 onward carries a mandatory adversarial
review bet, run by a reviewer with no authorship stake in the phase, with the
right to declare a gate failed. Its findings enter the record before the gate
closes, not after.

---

## 3. Three finish lines

The program has been chasing the first of these and speaking as though it had
crossed all three.

**Finish line A, research.** The exams in section 2 of the execution plan, met on
their stated terms. Status: 4 midterms met (one on softened terms), 3 finals
delivered of 5, 2 finals never attempted.

**Finish line B, evidence.** Every held result is (a) re-derived on a schedule,
(b) measured at least once against data the program did not author, and (c) has
survived one adversarial review it did not commission. Status: not started.

**Finish line C, product.** At least one moonshot capability reachable by a user
who has never read `docs/vision/`. Status: exactly one item crossed
(`ifc-lite gym`). `@ifc-lite/provenance`, declared the trust root of six
moonshots, is a private prototype at version 0.0.1 with zero callers outside
demo scripts.

**Definition of done for this program: A, B and C, in that order of difficulty,
with C scoped to one deliberate landing rather than six.**

---

## 4. Heilmeier catechism for the finish

Only the answers that changed since 2026-07-24 are restated. Where an answer is
unchanged, the original stands.

### M1 proof-carrying buildings

- **What is new (revised):** the library, the node-hash spec, the memoized DAG
  engine and cheap third-party verification are all built and demonstrated. What
  is new from here is nothing technical. It is integration: the first product
  surface where a change ships with a certificate a stranger can check.
- **Risks (revised):** the dominant risk is no longer hash instability, it is
  **orphaning**. A trust root with no callers is a research artifact that will
  drift out of sync with the product it claims to secure. Second risk: the M1
  midterm has never been run in its stated form (the mesh-bearing run used
  duplex, the 100 MB scale run skipped mesh leaves; the two halves have never
  been done at once).
- **Exams (added, Phase 4):** midterm as literally worded, single run: a wall
  edit on the 169 MB Holter Tower fixture **with real geometry-mesh leaves
  present**, certificate verified in a second process in under 500 ms while
  resolving under 5% of DAG nodes.

<!-- numeral-ok: 169MB :: the on-disk size of the Holter Tower fixture
     (tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc). A fact about a
     file, recorded in tests/models/manifest.json; no bet artifact emits it. -->

### M2 world gym

- **How is it done today (revised):** by us, and broken by us. The benchmark's
  answer key is publicly computable and the attack that proves it is committed
  in the repo scoring a perfect 1.000.
- **Risks (revised):** launching v1.0 publicly would be a reputational
  liability, because the first serious adversary reproduces `clean-twin-diff` in
  an afternoon. The integrity choice is a fork in the design premise, not a
  patch: "regenerable by anyone" and "unbreakable answer key" cannot both hold.
- **Exams (revised):** the M2 final's "one external group post-trains and
  improves on a held-out split" clause is retained, and gated behind an
  integrity model that survives `clean-twin-diff` on the split being reported.

### M3 differentiable buildings

- **Risks (revised):** the spike gate passed on closed-form volume formulas,
  which the red team correctly notes were never in doubt. The kill risk named in
  the original plan (adjoints through the CSG path may be intractable) is
  **still entirely unmeasured**, and B3.3 spent Phase 3 building certificate
  infrastructure on the safe side of it. Additionally, M6c's economic loss
  removes the GPU from the projection-speed story, so the interactivity claim
  now depends on M6b shipping.
- **Exams (added, Phase 4, binary):** adjoints through the real mesher on the
  rectangular-extrusion family, differentiating divergence-theorem volumes with
  respect to design parameters, matching central finite differences to 1e-6
  relative on 95% of a 200-point seeded battery. Pass means M3 is a moonshot.
  Fail means invoke the pre-committed downgrade.
  **RETRACTED 2026-07-29 (amendment 6; PROVISIONAL until the docs PR #1897 is
  merged by the repo owner, which is what gate-holder sign-off means - see
  section 9.1).** This exam was run and passed, but against the extrusion mesher
  rather than the CSG path M3's kill risk names, so "pass means M3 is a
  moonshot" does not hold. M3 is UNADJUDICATED pending the Phase 5 CSG-adjoint
  bet.

### M4 provable merges

- **Risks (revised):** the theorem is stated over an op model that cannot
  represent the hazard the spatial rule exists for. In 1,000 schedules the
  spatial rule produced 35 false conflicts and **zero** true ones, so both the
  headline ("zero unsound auto-merges") and the kill metric are measured on a
  distribution that cannot adjudicate them.
- **Exams (revised):** the midterm's false-conflict figure must be reported
  **restricted to schedules where the spatial rule fired**, under spatially
  coupled apply semantics, against the plan's existing < 20% bar. The final
  (B3.1, encrypted, three clients) is unchanged and unbuilt.

### M5 grounding compiler

- **Exams (amended, see section 9):** the midterm's "wide margin" clause is not
  supported after two tiers and one replication, and should be formally amended
  to the quantity the evidence does support. The amendment as landed in
  `moonshots-execution-plan.md` reads: correctly handles infeasible briefs at a
  rate exceeding budget-matched baselines, and **recovers from held-out-rule
  violations**, both with pre-registered paired CIs, with feasible-brief quality
  reported as a null result. Recovery is not guaranteed and the amendment must
  not be read as saying so: it is bounded by the tier-2 arm's repair cap of 2
  (at most three calls per task), and the executed exam showed run 1 at 6/6
  recovery with the replication exhausting that cap on T2-10, which then scored
  0. The defensible claim is "6/6 in one run, with a known cap-sensitivity",
  which is what section 1.2 already records.
- **Risks (revised):** at Haiku strength the proposer does not make intent-level
  errors often enough for decode-time feedback to show a quality margin. A wide
  margin needs either a weaker proposer or briefs whose constraint interactions
  defeat three informed samples. Both are available; neither has been tried.

### M6 geometry at silicon speed

- **What is new (revised):** M6c's contribution is now a negative result with a
  precise boundary (exact-tier evaluation versus adaptive filtering), which is
  more publishable than a marginal win and less useful to the other moonshots.
- **Risks (revised):** M6b is now load-bearing for M3's interactivity and is
  still not wired into production.
- **Exams (unchanged for M6a/M6b; M6c retargeted):** M6c's remaining exam is a
  paper, not a speedup.

---

## 5. Phased roadmap, Phase 4 to 6

Cadence unchanged: Shape Up 6-week cycles, phases end at a betting table that
doubles as the gate review, gate criteria pre-committed and amendable only in
writing in this file. Maximum five bets per phase, per the original pre-mortem.

### Phase 4, one cycle. "Standing evidence and the two open findings."

The shortest phase and the highest leverage. Nothing new is claimed; what is
already claimed is made durable and the two open red-team findings are closed.

**B4.1 The standing-evidence lane (instrument 5).**
A scheduled `moonshot.yml` running: provenance vitest, g0/g1/g2 demos, the b35
five-act demo asserted against its seeded report hashes, both tamper batteries,
the diff-spike gradient battery at reduced point count, a short certified run
verified in both FULL and SPOT mode, and world-gym `determinism-check`. Weekly,
plus on any change to `rust/geometry`, `packages/create`, `packages/provenance`
or `packages/wasm`.
*Exam:* green in under 20 minutes; a deliberate one-bit kernel perturbation
turns it red and names which act broke. *Read "one-bit" as "the smallest change
the artifact can represent": the committed report rounds carbon to 3 decimals,
so a literal one-ULP nudge is below its serialization floor. The attested
perturbation is 1e-6 relative, ~300x above the measured ~3e-9 floor.*

*Result and a correction to this bet's own premise (2026-07-27).* The lane is
built and both halves of the exam are met: 33-36 s of assertions, ~1m45s
end to end locally, and a real kernel perturbation (`depth * 1.000001` inside
`extrude_profile`, wasm rebuilt) turns it red naming act 5 and the three
kernel-validation fields that moved. Two things learned by building it that
this plan had wrong:

1. **The tamper batteries are a forgery test, not a drift test.** The lane
   builds a certified chain and verifies it *in the same run*, so the endpoint
   certificate binds a measurement taken by the same binary the verifier uses:
   chain and verifier move together and a kernel change cannot make them
   disagree. Confirmed empirically - under the kernel perturbation above, every
   chain and tamper step stayed green. **The only standing regression signal
   against kernel drift is the committed B3.5 golden**, because it is the one
   assertion whose reference does not move. A green tamper battery is evidence
   about forgery resistance and says nothing about stability.
2. **The tripwire's floor is the report's rounding, not machine epsilon.** A
   one-ULP carbon-factor perturbation stays green (the demo report rounds carbon
   to 3 decimals, parameters to 6); 3e-9 relative is caught. "One-bit
   perturbation" in this exam should be read as "a perturbation that survives
   rounding", which is the honest bar.

<!-- numeral-src: 3e-9 :: none - the measured sensitivity FLOOR of the B3.5
     golden, i.e. a property of the tripwire established by injection and
     transcribed in scripts/moonshot/ci/self-test-evidence.txt, which is a .txt
     and so is not in the artifact index at all. It is not a value any report
     emits, and it must not be: the golden pins measurements, not its own
     resolution. Negative-bound 2026-08-01: B4.4's artifacts joining this tree
     put 3.142876596321449e-9 in the union index (one cross-check row's
     wasm-versus-native volume deviation, an unrelated quantity), which made
     this floor read as backed and sent the excuse STALE. -->

*G4 review note (2026-07-29): both halves of this exam are attested rather than
evidenced and the bet does NOT yet pass.* The only observed run is 5m27s but was
a `pull_request` event, i.e. the configuration in which the two Holter-gated
steps skip - so "green in under 20 minutes" has not been demonstrated in the
configuration the exam describes. The perturbation half has **no committed
artifact**: it exists as prose in a commit message. The plan states B4.1 may not
roll over, so this must be closed with a committed red-run log or a `--self-test`
mode plus one `workflow_dispatch` run with the Holter fixture. The review also
audited all 17 assertion steps and found **1 genuine drift tripwire, 8
self-consistent, 8 that never touch the kernel** - the blind spot is broader
than the tamper batteries alone, and the smallest detectable regression is
~3e-9 relative on a volume-derived scalar over one 74-element synthetic model
(a winding or orientation regression whose volume integral is unchanged passes
green).

*Closed 2026-07-29, and the record now says which perturbation was used.* Both
halves are evidenced, and the two artifacts are deliberately not the same thing:

- **Timing.** One `workflow_dispatch` run with the Holter fixture,
  run 30441941453: **10m 01s** whole job with both Holter-gated exams running,
  against a 20-minute bar. Transcribed in
  `scripts/moonshot/ci/self-test-evidence.txt`.
- **Kernel perturbation, the real one.**
  `scripts/moonshot/ci/kernel-perturbation-evidence.txt` is the verbatim red run
  of a **one-line change to `extrude_profile` in `rust/geometry/src/extrusion.rs`**
  (`let depth = depth * 1.000001;`, +1e-6 relative on every extruded depth),
  **with the wasm bundle rebuilt from source**. The golden goes red naming act 5
  and exactly three paths, all under `acts/act5/data/kernelValidation/`; reverting
  and rebuilding returns it to green. Reproduce with
  `node scripts/moonshot/ci/assert-b35-golden.mjs --kernel`.
- **What runs in the lane is NOT that.** Step E3c
  (`assert-b35-golden.mjs --self-test`, ~12 s) perturbs a **JavaScript** carbon
  constant, because two wasm rebuilds cannot sit in a lane whose whole budget is
  20 minutes. The G4 re-review showed the two are not interchangeable: the JS
  self-test still passes if the wasm kernel is disconnected from act 5 entirely,
  since its only kernel-flavoured assertion is that `kernelCarbonKg` moved and
  that field is a product with the perturbed constant. So E3c is the in-lane
  tripwire-can-fire check; the kernel artifact is the end-to-end proof; and this
  plan now says which is which rather than letting one stand in for the other.

*Step E9, the numeral gate: what a green run does and does not mean (added
2026-07-30).* The lane's last assertion step runs
`scripts/moonshot/ci/check-report-numerals.mjs --gate` over every bet directory
and over `docs/vision/**`. **It is a contradiction gate, not a truth gate**, and
its own calibration is quoted here so a green E9 can never be read as
verification. The checker perturbs each numeral in a document by a seeded three
to thirty percent - far outside any rounding or unit story, i.e. definitely
wrong - and re-runs the matcher. On the `docs/vision` prose, whose haystack is
the union of every moonshot artifact in the tree, **between roughly 40% and
91.7% of those deliberately-wrong decoys came back "backed" by coincidence**,
depending on the document, with this one at the bottom of the range. The exact
span is printed by the checker at the end of every run, computed from that run
rather than transcribed, because a figure this document quotes about itself is
a figure editing this document changes. Two further limits, both measured rather
than feared: about a fifth of the numerals in the checked corpus are excused by
self-certified inline `numeral-ok` markers, a quarter once
`numeral-src: ... :: none` assertions are counted too, and re-introducing a
known-wrong figure together with a marker makes the finding vanish. What a green
E9 does establish is narrow and still worth having: no sentence in the checked
corpus contradicts a committed artifact it names, and no excuse has outlived its
reason.

*The fix is per-claim binding, not a bigger haystack.* A second marker form
names the artifact and JSON path a figure came from -
`<!-- numeral-src: 899 :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.verifyMs -->` -
so that figure's haystack is one value and its decoy pass rate is zero. A
binding that resolves and disagrees is a hard gate failure, and it is the only
check in the program that can say *this sentence contradicts the field it claims
to quote*. A binding into a bet directory not yet in this tree is PENDING: not
counted as backed, its decoys never cleared, and enforced the day the branch
lands. This document's load-bearing figures were bound on 2026-07-30, and this
document's own decoy rate fell as a result. **Over its bound subset alone the
decoys clear at 0.7%, against roughly three quarters for the figures still left
to the union index** - that gap, not the headline, is the number that shows the
mechanism working. The rest of the fall is arithmetic, since every figure moved
out of the union stops being a coin flip. The union-index remainder is what
"backed" is still worth for the figures that are not bound, and it is not much.

*Why these calibration figures moved.* An earlier revision of this section
quoted 57.5% to 91.7%, 69.0% and 43.8%. Those were real measurements of a
checker whose decoy generator was broken for exponent-form numerals: it read the
decimal count off the whole string, so a decoy for `2.19e-13` was written
`toFixed(6)` and became `0.000000`, a value most artifacts hold somewhere. Every
exponent-form figure in the program was therefore calibrated against a decoy of
zero. Fixed in PR #1897, which is why the rates fell; nothing about the corpus
changed.

<!-- numeral-src: 40%, 57.5%, 91.7%, 69.0%, 43.8%, 0.7% :: none - this checker's own decoy
     calibration over docs/vision, printed by
     scripts/moonshot/ci/check-report-numerals.mjs and deliberately NOT emitted
     into any artifact: an artifact under scripts/moonshot/ joins the union
     index this figure is a measurement OF, so emitting it would let the number
     back itself. Reproduce with `node
     scripts/moonshot/ci/check-report-numerals.mjs`, which prints the exact
     span. The prose above is deliberately coarse at the low end and exact only
     at 91.7% (node-hash-v0.md, the one document in the corpus this section
     cannot perturb): this section is self-referential, so a low endpoint stated
     to one decimal is a number that moves every time the paragraph quoting it
     is edited. Its own bound-subset rate, 0.7%, survives that because it is
     stable to one decimal against small edits; the unbound rate is given in
     words for the same reason. The superseded 57.5%, 69.0% and 43.8% are quoted
     only to retract them, in the paragraph that does so. -->

Consequence for instrument 5: the certificate and tamper results are held by
the lane in the *forgery* sense only. Holding them against drift would need a
committed golden chain verified by a current binary, which is a bet, not a
line in this one.

**B4.2 Spatially coupled merge semantics (bet AGAINST the B2.1 finding; B2.1
stays OPEN - see "what B4.2 closed" at the end of this entry).**
Give the op model semantics that can fail: hosted openings must remain inside
their host wall, `geometry-replace` triggers a re-cut, ops can be rejected on
spatial grounds. Re-run the 1,000-schedule battery.
*Exam:* false-conflict rate restricted to schedules where the spatial rule
fired, reported against the < 20% bar, with the count of spatial-only **true**
conflicts stated explicitly.
*Binary consequence:* if the spatial rule still yields zero true conflicts under
coupled semantics, delete the rule and say so in the ledger. A predicate that
never fires truthfully is not a contribution.

*G4 result note (added 2026-07-30). B4.1, B4.4 and B4.5 each received an inline
result note and this bet - the only one that FAILED its bar - did not. That gap
is closed here.*

**The exam FAILS.** The restricted false-conflict rate is **40.82%** (20 of 49
schedules where the spatial rule fired) against the plan's < 20% bar, and it
fails on its own terms: the Wilson 95% interval [28.22%, 54.75%] excludes 20%.
**Its denominator is not the bar's**, and the record must not be read as though
it were. Three ratios, named with their denominators:

| ratio | value | denominator |
|---|---|---|
| the bar's own quantity (false positives over commuting schedules) | 8.78% | ground-truth-commuting schedules - **passes** |
| like-for-like comparator (precision-complement over all flagged) | 66.14% | flagged schedules |
| the reported restricted rate | **40.82%** | flagged schedules where the spatial rule fired - **fails** |

Against its like-for-like comparator the spatial rule over-approximates *less*
than the predicate as a whole. Both facts are true and the record carries both.

**The verdict was KEEP, and the threshold that produced it was
delete-iff-zero.** The binary consequence above reads "if the spatial rule still
yields zero true conflicts, delete the rule", so a single true conflict in 1,000
schedules would have kept it. A pre-committed bar that one event clears is not a
test of the rule; it is a test of whether the op model can produce the event at
all.

**Derived-cut sensitivity, measured rather than argued** (schedule stream pinned
to the baseline, so every cell attributes the same events):

| cut semantics (rows) against containment (columns) | enforced | off |
|---|---|---|
| **lazy** (this bet's default) | **9** | 9 |
| **derived** (IFC, and this repo) | 3 | **0** schedule-matched; 1 when the stream is regenerated under that variant's own semantics |

**The audit's finding, plainly: the delete-clause was evaluated on the one cell
manufactured so that the rule can fire** - the default cell, top-left. The
stored lazy cut is the dominant mechanism and sustains the whole count on its
own, which is why turning containment off alone changes nothing; containment
becomes load-bearing only once cuts are derived. IFC does not store cuts, and neither
does this codebase - `rust/geometry/src/void_index.rs` builds host-to-openings
from `IfcRelVoidsElement` and `router/voids/` subtracts at load time from the
uncut Body, and the kernel is built for overhanging cutters
(`drop_faces_outside_host`), so IFC imposes no containment either. Under the
semantics IFC and this repo's own kernel implement, the rule's true catches fall
to **zero or one**. The residual case is a referential-integrity hazard - an
opening added into an element another client removes, i.e. `IfcRelVoidsElement`
integrity - which a read-set check over relationship targets would catch without
any geometry at all. KEEP therefore stands on replay-cost avoidance, not on
soundness: `createCommutationCertificate` replays both orders regardless of the
predicate, so zero unsound certificates are emitted with or without the rule.

**What B4.2 closed, and what it did not.** Three claims with three different
denominators, separated because this record has run them together before:

1. *The plan's M4 kill criterion is met, and B4.2 did not need to close it.*
   That criterion reads "false-conflict rate below 20%" and is measured over
   ground-truth-commuting schedules: **8.78%** (84 of 957), `killCriterionPass:
   true` in the battery's own output.
2. *B4.2's own restricted exam is not met.* 40.82% (20 of 49),
   `spatialKillCriterionPass: false`. This is a precision-complement over
   flagged-and-spatial-fired schedules; the battery's `ratios.note` says in as
   many words that its like-for-like comparator is the 66.14% flagged rate and
   **not** the plan's < 20% bar. Both numbers are true at once because they are
   not the same quantity.
3. *The B2.1 finding itself is NOT closed.* B2.1 said the spatial predicate was
   unfalsifiable: it had never produced a true conflict, so neither the headline
   nor the kill metric could be adjudicated on it. Coupled semantics did make it
   fire truthfully - 29 true conflicts among the 49 schedules where the spatial
   rule fired, 9 of them spatial-only, against zero before the bet. But the
   derived-cut grid above shows that count is a property of the lazy-cut cell,
   and under the cut semantics IFC and this codebase actually implement it falls
   to zero or one. A rule that fires truthfully only under semantics nothing in
   the stack implements is unfalsified in the sense B2.1 meant, which is why
   section 1.2 still carries B2.1 as OPEN.

B5.1 on real traces remains the only test that adjudicates this, which is what
the bet's own PR says.

<!-- Re-adjudicated 2026-08-01, when B4.2's artifacts joined this tree. B4.2 is
     still the one Phase 4 bet that commits no scorecard JSON of its own, but it
     re-blesses the B3.5 golden's act-4 battery block, and four of the seven
     tokens below turned out to be fields in it. Asserting "no artifact in any
     tree backs them" of those four is now false, and a negative binding is never
     reported STALE, so the anti-rot check could not have caught it: it is
     corrected by hand here. The three that remain blocked are the ones the
     battery genuinely does not emit. -->
<!-- numeral-src: 40.82% :: ci/b35-golden.json#acts.act4.data.battery.spatialFiredFalseConflictRate -->
<!-- numeral-src: 8.78% :: ci/b35-golden.json#acts.act4.data.battery.falseConflictRate -->
<!-- numeral-src: 49 :: ci/b35-golden.json#acts.act4.data.battery.spatialFiredFlagged -->
<!-- numeral-src: 957 :: ci/b35-golden.json#acts.act4.data.battery.groundTruthConvergent -->
<!-- numeral-src: 66.14%, 28.22%, 54.75% :: none - the like-for-like comparator
     and the Wilson interval on it. These are computed from the battery's numbers
     rather than emitted by it: they reach the record only through
     scripts/moonshot/g2-merge-soundness.mjs stdout and the tests that pin it in
     packages/provenance, so no artifact backs them and no coincidental hit in
     the union index may be allowed to look like one. Emitting the three ratios
     into a scorecard from that script is the cheapest remaining item in the
     instrument-5 backlog. The derived-cut grid's own small integers cannot be
     bound either way: a file-scoped marker on a bare digit would also block the
     honest matches that digit has elsewhere in this document. -->

**B4.3 Benchmark integrity v1.1 (aimed at the B2.2 finding; human decision).
STATUS: PENDING. Nothing about it is closed.**
Choose one of the three documented options and implement it. Recommendation, for
the record and subject to the betting table: **hosted episode bytes for test,
dev left open and explicitly labelled attackable-by-design, with
`clean-twin-diff` cited in the spec as the reason.** This preserves local
iteration, stops the spec claiming an integrity property it does not have, and
defers the salt decision until a hosted scorer exists.
*Exam:* `clean-twin-diff` scores at or below the always-clean anchor on the
reporting split; spec version bumped; the attack stays committed as a
regression.
*Why it is PENDING, spelled out so no reader has to infer it.* Three things must
happen and none of them has:

1. **The integrity-model decision.** Secret per-split salt versus hosted episode
   bytes is Louis's call and has not been made. The recommendation above is a
   recommendation, not the decision.
2. **The implementation of whichever option is chosen**, including the spec
   version bump.
3. **The clean-twin check re-run against it**, i.e. `clean-twin-diff` scoring at
   or below the always-clean anchor on the reporting split rather than the 1.000
   aggregate it scores today.

Until all three are done, B2.2 stays **CONFIRMED, UNFIXED** in section 1.2 and
this bet is not a Phase 4 delivery.

**B4.4 The M3 kernel-adjoint spike (binary).**
A dual-number scalar type through the mesher for the rectangular-extrusion
family, differentiating divergence-theorem volumes.
*Exam:* as section 4. Two cycles' worth of risk compressed into one; if it needs
more than one cycle to reach a verdict, that is itself the answer.
*G4 review note (2026-07-29), the note this entry should have carried from the
start:* delivered and reproduced at 200/200, with production behaviour proved
byte-identical over 4,000 cases on the native build - but **against the
extrusion mesher, not the CSG/void path M3's kill risk names.** The bet's own
oracle shows that path's volume is a smooth closed form, so the exam could not
have failed. This entry does **not** adjudicate M3's binary gate; see amendment
6. The 40% of components graded against a theoretical zero rather than against
finite differences are covered by amendment 7.

**B4.5 The M1 midterm as worded.**
Mesh-bearing DAG at 169 MB scale, both halves in one run.
*G4 review note:* delivered and reproduced, but **only clause 1 (<500 ms) had a
real failure mode**. Clause 2 resolves O(storeys) nodes regardless of model
size, so a bigger model makes it easier; clause 3 would need one wall edit to
recompute >25,058 nodes to fail. Do not quote "PASS on all three clauses" as
three independent results. The pass also holds only for a **storey-granularity**
claim: at element granularity, which is the shape the M1 *final* exam's
region-scoped permission actually needs, both clauses FAIL (24.27%, 899 ms).
That row belongs in B6.1's risk register.

*Addendum 2026-07-29, and it cuts against the review.* The review's other B4.5
catch - a table row "21,777 nodes / 12.62% / 465.4 ms / FAIL" that **no artifact
produces** - was half right. Committing the bet's `--no-aggregates` run as
`scripts/moonshot/b45-m1-midterm/scorecard-no-aggregates.json` shows the row is
the element-granularity claim measured on the **g0/g1 DAG shape**: that
artifact's `sensitivityElementGranularityClaim` reads `nodesResolved` 21,777 and
`nodesResolvedPct` 12.6224, matching the row to the digit. Only the timing was a
different run's. So the row was a real measurement in the wrong table (it varied
two axes in a table that varies one), not an invented one, and the underlying
defect in both directions is the same: a figure whose run was never committed.
It is committed now. Recorded here rather than by editing the dated review.

<!-- numeral-src: 21,777 :: b45-m1-midterm/scorecard-no-aggregates.json#sensitivityElementGranularityClaim.nodesResolved -->
<!-- numeral-src: 12.6224, 12.62% :: b45-m1-midterm/scorecard-no-aggregates.json#sensitivityElementGranularityClaim.nodesResolvedPct -->
<!-- numeral-src: 465.4ms :: none - the uncommitted run's timing, quoted here
     only to show it does NOT match the committed 453.5 ms. It must never read
     as backed; if it does, the sentence around it has become false. -->

<!-- numeral-ok: 25,058 :: a bound the G4 reviewer derived from the
     scorecard's clause-3 headroom, not a measurement. -->
<!-- numeral-src: 24.27% :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.nodesResolvedPct -->

*(Corrected 2026-07-29: this sentence read "907 ms" against a committed
`scripts/moonshot/b45-m1-midterm/scorecard.json` whose
`sensitivityElementGranularityClaim.verifyMs` is 899. The wrong figure was
introduced by the commit remediating the previous round of wrong figures, in a
document the numeral checker could not then see - which is why its search root
now covers `docs/vision/**`. What that gate is and is not worth is quoted with
the lane's step E9 above; the figure below is bound per-claim to the field it
comes from rather than left to the union index.)*

<!-- numeral-src: 899ms, 899 :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.verifyMs -->
<!-- numeral-src: 907ms :: none - quoted only in order to retract it. It is the
     figure this correction removes, and a coincidental hit in the union index
     must not be allowed to vindicate it. -->

*Exam:* under 500 ms verification, under 5% of nodes resolved, over 90% cache
hits on single-wall recompute, with real mesh leaves present throughout.

<!-- numeral-src: 500ms, 5%, 90%, 95%, 20%, 1e-6 :: none - the exam BARS
     of this phase. A bar is a decision this plan made, not a measurement any
     bet emits, so it must never read as backed: before these were bound, every
     one of them was being cleared against an unrelated field of
     b34-kernel-stage/report.b34.json, which is the union-haystack pathology in
     its purest form. -->
<!-- numeral-src: 200 :: b44-kernel-adjoint/battery.json#[0].npoints -->

**Gate G4.** All five exams above, plus the first standing adversarial review
(instrument 7) commissioned against Phase 4's own results. Fail on B4.1 is not
permitted to roll over: without the lane, later gates cannot know whether
earlier results still hold.

### Phase 5, two cycles. "Contact with the world."

The phase the program has been avoiding. Every bet here is measured on data
authored elsewhere.

**B5.1 Real merge traces.** Replay the merge battery against captured
multi-user collab sessions (the audit logs already exist).
*Exam:* false-conflict rate on real traces against the < 20% kill bar. This is
the metric the original plan named and the program has never measured.

**B5.2 Foreign IFC.** Run the benchmark's three tasks, and the defect detector,
against real third-party files (`tests/models`, the IfcOpenShell parity corpus,
and at least one file exported from Revit or Tekla that nobody in this program
has seen).
*Exam:* report the score delta versus the synthetic corpus. Any delta is the
finding; a large one is the most valuable result of the phase.

**B5.3 Foreign briefs.** 30 or more M5 briefs written by people who are not the
program, three samples each, pre-registered paired CIs, tier-2 rubric.
*Exam:* infeasibility handling and repair recovery replicate on foreign briefs;
feasible-quality margin reported with its CI whatever it says.

**B5.4 B3.1 encrypted provable multiplayer (the unbuilt M4 final).**
Three clients, randomized schedules, byte-identical convergence verified by
hash exchange, server provably never holding plaintext.

**B5.5 B3.2 scan-to-parametric (the unbuilt M5 final).**
One real scanned room to parametric IFC, headline quantities within 5% of a
manually modelled reference, plus one world-model scene imported with a bill of
quantities. This is the highest-variance bet in the program and the one whose
success would be least deniable.

**Gate G5.** M4 final, M5 final, plus the external-validity clauses of B5.1 to
B5.3. Second standing adversarial review, mandatory.

### Phase 6, two cycles. "Landing and publication."

**B6.1 The one deliberate landing (finish line C).**
Certificates into the collab layer's layer publish and review flow. That surface
already has provenance records, named AI peers, per-principal rate limits and
audit logs, so the certificate is the missing artifact rather than a new
concept, and it turns M1 into the governance layer the agentic-BIM press keeps
describing. Ship `ifc-lite verify` alongside as the headless entry point.
*Exam:* `@ifc-lite/provenance` is no longer `private`, has at least one non-demo
caller, and an agent edit made under a region-scoped permission is verified by a
third party who never downloads the full model. That last clause is the M1 final
exam, and it only makes sense once there is a product surface to make the edit
on.

**B6.2 Hosted benchmark and one external lab.**
The M2 final. Gated on B4.3.

**B6.3 The M6c paper.** Exact predicates on WebGPU: the technique, the
sign-exactness proof, the parity manifests, and the negative economic verdict
against adaptive filtering. The negative result is the interesting half and
nobody else is positioned to publish it. Note the shelf life: WGSL i64 or a
WebGPU f64 extension would erode the novelty, so this is time-sensitive in a way
no other bet is.

**B6.4 The M4 convergence writeup.** Gated on B4.2 and B5.1, because the
theorem is only worth publishing with a real-trace conflict rate attached.

**B6.5 B3.5 v2: the demo, in a browser, on foreign data.**
The current integrated demo is Node, seeded, and synthetic end to end. The
version worth putting on a stage runs in browser tabs, starts from a file the
audience brought, and streams certificates. Same five acts, no synthetic
substrate.

**Gate G6 = the final exams**, all six moonshots, with the external-validity
clause attached to each. Third standing adversarial review, with the explicit
brief of attacking the program's summary of itself.

---

## 6. The stretch tier

Reaching for the stars, stated so it can be checked rather than admired. If all
of the above lands, the defensible claim in mid-2027 is:

**A building, from any origin, whose every change carries a machine-checkable
receipt; a public benchmark that grades machines on it; a compiler that turns
neural output into it; and a merge theorem that survives three encrypted
strangers editing at once, all running in a browser tab, all re-verified every
week by a robot that will tell you the moment it stops being true.**

Every clause in that sentence maps to a numbered exam above. Three of them are
close, two are unbuilt, one (M3's kernel adjoints) is a genuine coin flip, and
one (M6c) has already resolved into a negative result worth publishing. That
distribution is what an honest moonshot portfolio looks like at TRL 4 to 5.

The version that would be indefensible, and which the program is currently one
enthusiastic slide away from claiming, is the same sentence with the words
"verified", "public" and "real" doing work the evidence does not support.

---

## 7. What this costs

| Phase | Agent-cycles | Human days (Louis) | Cash |
|---|---|---|---|
| 4 | 4-5 (parallel) | 2 (gate) + 0.5 (B4.3 decision) | none |
| 5 | 6-8 | 3 (gate) + 1 (brief recruitment) + 1 (scan capture) | model budget for B5.3; scanner access or one purchased scan |
| 6 | 5-6 | 5 (gate) + paper writing + external lab outreach + open-sourcing decision on provenance | hosting for the benchmark scorer |

Roughly 15 to 19 agent-cycles over about 8 months. As before, agent-cycles are
not the scarce resource. The scarce resources are your gate time, three items
that only you can sign (benchmark integrity model, provenance package going
public, paper submissions), and one new item: **someone outside the program**,
needed three times (foreign briefs, foreign IFC, adversarial review). Budget
that as a real dependency rather than a favour, because Phase 5 cannot start
without it.

---

## 8. Kill criteria, updated

Pre-committed; ledger entry mandatory; resurrection requires new evidence.

- **M1:** if B6.1 has no non-demo caller by G6, M1 is a research artifact.
  Publish the spec and library as such, and stop describing it as the trust root
  of the other moonshots.
- **M2:** unchanged on realism transfer, plus: if B4.3's integrity model still
  falls to a clean-twin-class attack at G5, retire the word "benchmark" and call
  it an internal eval harness.
- **M3:** B4.4 is binary. **Superseded 2026-07-29 by amendment 6:** B4.4 was
  re-scoped to the extrusion mesher, so it does not trigger or clear this
  criterion; M3 is unadjudicated pending the Phase 5 CSG-adjoint bet. The
  downgrade clause below stands, unfired, and applies to that bet's outcome.
  Fail means the pre-committed downgrade to
  derivative-free optimization over the same objectives, with the B3.3
  certificate machinery retained (it is genuinely good and format-independent)
  and the "differentiable buildings" claim withdrawn.
- **M4:** if the real-trace false-conflict rate (B5.1) exceeds 20%, keep the
  theorem and drop the auto-merge product claim, exactly as originally written.
  New clause: if B4.2 shows the spatial rule produces no true conflicts under
  coupled semantics, delete the rule.
- **M5:** the "wide margin" clause is amended rather than killed (section 9). If
  B5.3's foreign briefs also show no feasible-quality margin, that is the
  finding, and the honest product claim narrows permanently to constraint
  discovery and infeasibility handling.
- **M6c:** already resolved. Retarget to publication. Do not spend another cycle
  chasing a speedup that the asymptote says is not there.
- **M6b:** if it is not wired into production by G5, M3's interactivity claim
  is withdrawn regardless of B4.4's outcome.

**Pre-mortem, updated.** The original three (diffusion of effort, human calendar
slips, maintenance starves the program) stand. Two new ones, both observed
rather than predicted:

4. **Building on the safe side of the risk.** Phase 3 skipped its two hardest
   bets and polished a third. Antidote: B4.4 and B5.5 are scheduled first within
   their phases, and a phase that delivers only its easy bets is recorded as a
   failed phase even if every delivered exam passed.
5. **Self-grading drift.** Every instrument in the program was authored by the
   program. Antidote: instruments 6 and 7, and the rule that a result which has
   not met foreign data is reported at half strength.

---

## 9. Amendments to the record, required in writing

Per the execution plan's own rule that only the betting table may amend gate
criteria, and only in writing in that file:

1. **M5 midterm, "beats an unconstrained baseline by a wide, stated margin":**
   amend to "correctly handles infeasible briefs at a rate exceeding
   budget-matched baselines, and recovers from held-out-rule violations, both
   with pre-registered paired CIs, with feasible-brief quality reported as a
   null result." Two tiers and one replication support this and not the original.
2. **M6c final, ">= 5x stage speedup on real models":** record as met literally
   and lost economically, with the 0.05x to 0.20x production-path comparison in
   the citation. Retarget the remaining exam to publication.
3. **Phase 3 status:** record as three of five bets delivered, with B3.1 and
   B3.2 carried into Phase 5 rather than silently absorbed.
4. **Negative-results ledger:** the plan mandates entries for killed or
   downgraded items and there are effectively none. Backfill: M6c's economic
   verdict, the benchmark integrity break, and the M5 feasible-quality null.
5. **Calendar:** replace the Phase 3 dates with actuals and this document's
   Phase 4 to 6 targets.

### 9.1 What gate-holder sign-off is

*Added 2026-07-30, because the sign-off recorded on amendments 6 to 8 was a
sentence one agent wrote about another.* Everything in this repository is
authored and committed by the same unsigned identity, so a prose line reading
"signed off by the gate holder" is indistinguishable in the git record from the
thing it disclaims. There is exactly **one real human signature act** available
here, and the plan now names it:

> **Gate-holder sign-off IS the merge of the gate's docs PR by the repo-owner
> account**, or equivalently a GPG-signed tag on the docs branch head. Nothing
> else counts. A merge is performed by an authenticated account that is not the
> agent's, it is recorded by the forge rather than asserted in the diff, and it
> is checkable after the fact by anyone with `gh pr view`.

Consequences, stated so they can be checked rather than trusted:

- **Amendments 6, 7 and 8 are PROVISIONAL until #1897 merges.** They are the
  proposed record, entered in writing per the plan's own rule and open to
  revision; they become the signed record at merge and not before.
- Nothing in Phase 4 has passed sign-off as of this writing: #1886, #1897,
  #1899, #1900 and #1902 are all open. A gate cannot close on unmerged branches,
  which is a second, independent reason G4 stays failed.
- Any future sentence claiming sign-off must name the PR or tag that carries it,
  so a reader can verify the claim without trusting the writer.

**Added 2026-07-29 after the G4 adversarial review failed the gate**
(`reviews/g4-red-team-2026-07-29.md`), and re-attested the same day
(`reviews/g4-re-attestation-2026-07-29.md`). These three are the review's
required item 1, entered here because the plan's own rule is that gate criteria
are amendable only in writing in this file - and the re-scope below was not.
**All three are provisional per section 9.1 until #1897 merges.**

6. **M3's Phase 4 exam was re-scoped, and the re-scope is recorded here rather
   than assumed.** `moonshots-execution-plan.md` names M3's kill risk as the
   **CSG/void path** being only piecewise-differentiable. B4.4's exam, written
   in section 5 of this document, targets the **extrusion mesher**. The bet's
   own oracle then proved that path's emitted volume is exactly
   `det*xdim*ydim*depth` to 2.19e-13 across the **600 family-A points** that
   closed form covers (corrected 2026-07-29: the battery's other 600 points are
   family B, which has a distinct oracle and a battery-wide worst deviation of
   1.358479e-12). The conclusion is unchanged and the smoothness holds for both
   families - a functional containing no piecewise-differentiability risk.
   <!-- numeral-src: 2.19e-13 :: b44-kernel-adjoint/battery.json#[0].maxOracleRelDev -->
   <!-- numeral-src: 1.358479e-12 :: b44-kernel-adjoint/battery.json#[5].maxOracleRelDev -->
   **B4.4's PASS
   therefore does NOT retire M3's kill risk and does not trigger or clear the
   binary gate as originally stated.** M3's status is amended to: *adjoints
   reach the real mesher on a smooth family, verified byte-identical to
   production on the native build; adjoints through CSG remain entirely
   unmeasured.*

   **The CSG-adjoint bet is NOT yet scheduled** (corrected 2026-07-29 by the G4
   re-attestation, which caught this sentence asserting the opposite while the
   commit that wrote it declared option (b)). This amendment takes the
   re-review's **option (b)**: the scheduling claim is withdrawn and M3's status
   is recorded as UNADJUDICATED pending Phase 5, dated. Entering the bet is a
   betting-table act, not a sentence in an amendment: it needs a number, an
   exam, a kill clause, a statement of which of B5.1-B5.5 it displaces against
   the five-bet cap, and a cycle-budget update. None of those exist yet.
   `scripts/moonshot/b44-kernel-adjoint/DESIGN.md` section 6.1 scopes the work
   at two cycles and names the obstruction (the exact-predicate tier is a
   fixed-width integer type with no derivative slot), which is the input to
   that decision, not the decision.
7. **B4.4's grading metric amends the exam's finite-difference wording.** The
   exam reads "matching central finite differences to 1e-6 relative on 95% of a
   200-point seeded battery". The delivered result matches central finite
   differences on **60% of components**; the other 40% (rigid motions, void
   translation) are graded against a theoretical zero, because a relative
   metric cannot adjudicate a zero derivative at any tolerance. The partition
   is mathematically sound and the review confirmed no parameter is
   misclassified - but it is an amendment and is recorded as one. Note also
   that the accompanying "0/200 on the old metric" figure is partly a property
   of the U(-30, 30) m placement box, not of the metric alone.

   *The amended pass condition, written out so it can be re-graded without
   reading the harness.* **Denominator: points, not components.** Each battery
   is 200 seeded points, a point passes iff **every** component at that point
   passes, and the bar is the exam's own **95% of 200**. Components are
   partitioned once, by parameter, before any measurement:
   - **Active components** are graded strictly: relative agreement with central
     finite differences within **1e-6**, unchanged from the exam's wording.
     Family A is 10 parameters per point of which 6 are active (1,200 of 2,000
     components); family B is 14 of which 8 are active (1,600 of 2,800). The
     "60% of components" figure above is family A's split; family B's is 8 in
     14.
   - **Invariant components** are the parameters whose analytic derivative is
     zero by construction (rigid motions, void translation). They are graded
     against that theoretical zero, as `|ad| / ||ad||_inf` at the same point,
     and pass only if that ratio is at machine-noise level. They are **not**
     compared to finite differences at all, and this is the whole amendment:
     FD noise on those components measures up to 7.451817e-8 absolute against a
     true value of 0, so any relative FD criterion fails them at every
     tolerance.
   The delivered result under this rule: **200/200 on five of the six
   (family, seed) batteries and 199/200 on the sixth**, all six PASS against the
   95% bar; worst active relative error 1.262e-6 at the single failing point,
   worst invariant ratio 2.8e-14 across all six. The retired metric - the strict
   relative criterion applied to *all* components - scores 0/200 on every
   battery, which is the "0/200" figure above and is a statement about zero
   derivatives, not about the gradient.

   <!-- numeral-src: 199 :: b44-kernel-adjoint/battery.json#[5].passed -->
   <!-- numeral-src: 1.262e-6 :: b44-kernel-adjoint/battery.json#[5].maxRelErrActive -->
   <!-- numeral-src: 2.8e-14 :: b44-kernel-adjoint/battery.json#[1].maxInvariantAdRatio -->
   <!-- numeral-src: 7.451817e-8 :: b44-kernel-adjoint/battery.json#[5].maxInvariantFdNoise -->
   <!-- numeral-ok: -30 :: a bound of the harness's U(-30, 30) m placement box,
        a sampling-design constant declared in b44-kernel-adjoint/run.mjs and
        emitted by no report. -->
8. **Phase 4 is recorded as a FAILED phase under pre-mortem entry 4.**

   *Re-grounded 2026-07-30, after an audit of this amendment itself.* This entry
   originally grounded the failure as a phase that "delivers only its easy
   bets", which is pre-mortem 4's clause applied verbatim. That description is
   wrong in both directions: B4.2 and B4.4 were not easy - one required new
   merge semantics and published a failing number against its own bar, the other
   required a generic mesher refactor with a byte-identity proof over thousands
   of cases - and calling them easy hides what actually went wrong. The correct
   description is that **Phase 4 adjudicates only its safe questions**, on three
   grounds:

   (a) **B4.4's binary exam was written on a functional its own oracle proves
   smooth**, so it could not fail - and its PASS was then used to declare M3's
   kill criterion untriggered. Amendment 6 retracts that use.
   (b) **The M4 delete-clause was evaluated only under the op model that
   manufactures the rule's catches** - the stored lazy cut, which is the only
   cut semantics under which the rule's true catches survive at all. Under the
   derived cuts that IFC and this repo's own kernel implement they fall to zero
   or one. See B4.2's entry in section 5 for the measured grid.
   (c) **B4.3 was never delivered**, so gate G4's "all five exams above" clause
   could not close regardless of how the other four scored.

   **The antidote named in pre-mortem 4 is a null instrument, and this plan
   should stop citing scheduling order as one.** "B4.4 and B5.5 are scheduled
   first within their phases" presumes a serial schedule. Every delivered
   Phase 4 bet ran on the same morning in its own worktree; there was no
   "first", so the antidote never had an opportunity to apply. It would not have
   helped if it had: an exam moved to the safe side is safe whenever it runs.
   What would have caught all three grounds above is a different instrument -
   **the difficulty of an exam is adjudicated before the bet runs, by someone
   with no stake in it**, i.e. instrument 7 applied at commissioning time rather
   than at gate time. Pre-mortem 4's antidote is replaced by that.

   **The FAIL attaches to this phase's ADJUDICATIONS, not to its measurements.**
   All four delivered bets reproduce to the digit, and three of them volunteered
   the case against themselves before any reviewer arrived: B4.4's
   winding-orientation trap in `create_side_walls`, B4.2's failing restricted
   rate, and B4.5's granularity qualifier together with the geometry-traversal
   defect it found in g0/g1. That is instruments 5 and 7 working. Both reviews
   of this gate - the standing review and the re-attestation
   (`reviews/g4-re-attestation-2026-07-29.md`) - found errors of framing, scope
   and record-keeping, and neither found an error of fact.

---

## 10. Agent-buildable versus human-only, updated

**Parallel track (agents, no permission blocking):** the CI lane, coupled merge
semantics, the adjoint spike, the M1 midterm run, encrypted multiplayer
plumbing, scan-to-parametric pipeline, foreign-IFC scoring runs, browser demo,
paper drafts, all documentation.

**Serial human calendar (the real schedule), with the new items marked:**

- Benchmark integrity model decision (B4.3). **Blocking Phase 6.**
- **NEW: making `@ifc-lite/provenance` public and non-prototype.** Blocking
  finish line C. Note that the spec-freeze PR (#1886), which stamps
  `node-hash-v0` at 1.0.0 and bumps the package to 0.1.0, is itself still open
  and is a prerequisite: freezing the wire format is what makes a public
  package's compatibility promise meaningful.
- **NEW: recruiting the outside.** Foreign brief authors, a foreign IFC source,
  and an adversarial reviewer with no authorship stake. Blocking Phase 5.
- **NEW: one real scan.** Access to a scanner or a purchased scan plus a
  manually modelled reference. Blocking B5.5.
- Trust-root and signing-key custody (unchanged, now actually needed by B5.4).
- Paper submissions: M6c (time-sensitive), M4 (gated on real traces).
- External lab recruitment for the M2 final.
- V8 advocacy for wide-arithmetic (unchanged, still cheap, still only you).
- **NEW: gate-holder sign-off itself.** Section 9.1 defines it as the merge of
  the gate's docs PR by the repo-owner account. That makes merging #1897 not
  administrative tidying but the act that converts amendments 6 to 8 from
  proposed to signed, and it is the only signature act in this program that an
  agent structurally cannot perform or fake.
- Every merge to main.

---

## 11. First moves

This list is the outstanding blockers as of 2026-07-30, not the list this
section shipped with. The original four - write `moonshot.yml` (B4.1),
land amendments 1 to 5, take the B4.3 decision, schedule the Phase 4 betting
table and commission the G4 reviewer - are done except B4.3, which survives
below. B4.1's lane exists and both halves of its exam now have committed
artifacts; amendments 1 to 5 are in `moonshots-execution-plan.md`; the G4 review
was commissioned, ran, and failed the gate, and its re-attestation kept it
failed. Rewriting the list rather than ticking it is deliberate: a stale
"do this first" list is the same defect class as a stale figure.

In order:

1. **Merge #1897.** Section 9.1 defines gate-holder sign-off as the merge of
   the gate's docs PR by the repo-owner account, so this merge is what converts
   amendments 6 to 8 from proposed to signed. Nothing downstream of them is
   settled until it happens, and no agent can perform or fake it.
2. **B4.3 decision.** Secret per-split salt versus hosted episode bytes. One
   paragraph from you, then the implementation and the clean-twin re-check.
   Blocking Phase 6, and B2.2 stays CONFIRMED, UNFIXED until all three are done.
3. **Phase 5's external-data prerequisites**, which are lead-time items and not
   agent work: a foreign IFC source and real collaboration traces (B5.1),
   foreign brief authors (B5.2), and one real scan plus a manually modelled
   reference (B5.5). Phase 5 cannot start against internally authored
   distributions without repeating the finding that section 3 of the G2 review
   already made.
4. **The Phase 5 betting table**, which has to settle whether the CSG-adjoint
   bet enters at all. Amendment 6 leaves M3 UNADJUDICATED pending it, and
   entering it needs a number, an exam, a kill clause, a statement of which of
   B5.1 to B5.5 it displaces against the five-bet cap, and a cycle-budget
   update. None of those exist, and writing them is a betting-table act.
5. **Name the G5 adversarial reviewer before Phase 5's work finishes**, on the
   same logic that made G4 worth commissioning: a reviewer named afterwards
   reviews a record that has already hardened.

Item 1 is the only one that unblocks the rest of the stack; items 2 and 3 are
the two nobody else can do; item 4 is the decision the whole M3 line waits on.
