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

*Dated note, 2026-08-02.* Both of those bets have since been run and measured on
data the program did not author, as B5.2 and B5.5. That is the first evidence
against the pattern this paragraph names, and it is recorded once, in amendment
9, rather than restated here. It is evidence against, not a retirement: one
phase that did not skip its two hardest bets does not undo a phase that did, and
Phase 4's own FAILED verdict (amendment 8) is untouched by it.

### 1.2 The G2 red-team scorecard

The adversarial review (`reviews/g2-red-team-2026-07-24.md`) raised four
findings plus one structural criticism. Status as of today:

| Finding | Status | Detail |
|---|---|---|
| B2.3 (M5): exam cannot measure its claim | **CLOSED** | tier-2 exam 2026-07-25 implements all five required changes (rubric headroom proven at mean 0.847 spread 0 to 1; five validator rules held out of prompts; three budget-matched arms at k=3; 23 briefs including 3 infeasible; anti-laundering intent-fidelity multiplier), then replicated on fresh samples |
| B2.2 (M2): answer key is publicly computable | **CONFIRMED, UNFIXED** | `benchmark/attacks/clean-twin-diff.mjs` scores an exact **1.000 aggregate on dev** through the real scorer, above both anchors; spec bumped to `1.1.0` 2026-08-01, which WITHDREW the false hidden-by-hosting claim and declared the real model (per-split salt across every RNG stream, delivered by a hosted scorer) -- but neither half is implemented, so the finding is unchanged: the answer key is still publicly computable and the reporting split still has no integrity property |
| B2.1 (M4): spatial predicate unfalsifiable | **OPEN** | `merge-model.ts` still applies ops purely per-node; spatial-structure edits explicitly outside the v0 vocabulary; no real-trace replay |
| B2.4 (M3): gradients never touch the kernel | **OPEN and widened** | B3.3 built more certificate infrastructure on the parametric path instead of attacking adjoints through CSG |
| Section 3: nothing verifies against the external world | **OPEN, narrowed 2026-08-02** | B5.2 and B5.5 are the only results in the program measured on data it did not author (amendment 9); every other result is still measured on distributions the program authored. The narrowing does not reach the standing lane, and the claim is deliberately not written as if it did: neither run is re-runnable in CI, because the foreign models and the scan can be neither committed nor fetched. B5.5's only standing coverage is `E8b`, a synthetic closed-form proxy that holds the extraction/emission/scoring **pipeline** and asserts nothing about the headline number; B5.2 has no standing coverage at all. So the external-data evidence is two dated runs, not a lane |

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

**Superseded 2026-08-02 (amendment 12), and this is the sentence that started
the claim, so it gets the marker rather than a quiet rewrite.** The consequence
above is withdrawn along with the thing it was a consequence of: M3's
interactivity claim is withdrawn deliberately and ahead of G5, so there is no
per-step projection budget for M6b to be critical to, and **M6b is on no
critical path**. The paragraph is left as written because the record is supposed
to show how a claim was reached as well as when it was retired. M6b's TRL of 5
is unchanged and its own exam is unchanged; it is a validated but UNWIRED lever
with the dated re-entry condition in amendment 12. Ledger entry N5.

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

*Two rows of that table have dated notes elsewhere and are left as written here
rather than silently re-scored: M6b's "now on the critical path" was ended by
amendment 12 (the claim it was critical to is withdrawn; its TRL of 5 is
unchanged), and M3's "kernel adjoints untouched" is what B5.6 exists to change
(amendment 11). The table is a snapshot dated 2026-07-26; the amendments are the
running record.*

The column spans **TRL 3 to 6**, not a flat band: M6a is already 6, M3 and M4
are still 3, and the modal value is 4. Five of the eight moved up and none moved
down. That is a genuinely strong six-month position, with one shipped surface,
and it is not TRL 7 anywhere - which is what "finished" would require.

---

## 2. Framework: four instruments, plus four

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

**8. Exam integrity (answers: the scorer cannot fire, so the PASS means
nothing). Added 2026-08-02, amendment 14.** Instrument 7 asks whether an exam is
hard. This one asks whether its scorer is capable of returning FAIL at all, and
it is three clauses rather than a principle, because each one is pinned to a
defect this program shipped:

- **8a. No PASS without a committed red-run.** Every scorer carries a `--red`
  mode that constructs the specific violation it claims to detect, exits
  non-zero **through the same assertion path** a real failure would take, and
  commits the evidence of that run. A tripwire never observed firing is an
  untested branch, and its green is a statement about nothing.
- **8b. Verdicts by positive assertion only.** A verdict may never be taken from
  the absence of an exception, and never from a value the artifact under test
  **reports about itself** - a stored quantity, a self-declared status, a number
  the emitter wrote down. The thing being graded does not get a vote on its own
  grade. What this does *not* ban is measuring the artifact independently: B5.5's
  scorer meshes the emitted IFC and the manually modelled reference through the
  kernel and computes every headline quantity itself, reading no stored quantity
  from either side, and that is the compliant shape rather than the banned one.
  The test is whether the number came from the emitter's claim or from an
  instrument the emitter does not control.
- **8c. A null-space audit at commissioning.** Before the bet runs, enumerate
  the **invariance group of the scored observable** - the transformations of the
  emitted artifact under which every scored number is unchanged - and commit
  checks that, **taken together, distinguish every non-identity transformation
  in that group**. One non-invariant check does not discharge this: a check can
  catch one direction of the group and be blind to another, and the blind
  direction is exactly where the defect sits. If the committed checks cannot
  cover the enumerated group, then **narrow the group to what they do cover and
  record the remainder as unchecked** - a smaller honest claim, not a bigger
  unearned one. An exam whose null space is unchecked grades a quotient, not the
  thing.

What these three reach, and the one real defect only 8c reaches, is recorded in
amendment 14 rather than here, so the reader who wants the calibration gets it
in one place.

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

<!-- numeral-src: 169MB :: b45-m1-midterm/scorecard.json#fixtureBytes -->

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
  now depends on M6b shipping. **Superseded 2026-08-02 (amendment 12): rather
  than let the claim depend on a lever the ledger already refuted at whole-
  pipeline scale, the claim is withdrawn. M3's remaining risk is the CSG-adjoint
  question alone, and B5.6 is the bet that answers it.**
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
  still not wired into production. **Superseded 2026-08-02 (amendment 12): the
  interactivity claim is withdrawn, so M6b stops being load-bearing for anything
  and stops being a risk. It is a validated, unwired lever with a dated re-entry
  condition. Nothing downstream now waits on it.**
- **Exams (unchanged for M6a/M6b; M6c retargeted):** M6c's remaining exam is a
  paper, not a speedup.

---

## 5. Phased roadmap, Phase 4 to 6

Cadence unchanged: Shape Up 6-week cycles, phases end at a betting table that
doubles as the gate review, gate criteria pre-committed and amendable only in
writing in this file. Maximum five bets per phase, per the original pre-mortem.
**Amended 2026-08-02 (amendment 11): the cap is raised to six for Phase 5 only,
deliberately, with the argument written out in B5.6's entry below. It stays five
for Phase 6 and for every later phase - a raise is a betting-table act taken once
against a named phase, not a new default, and the second one has to argue for
itself the same way.**

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
`<!-- numeral-src: 845.6ms :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.verifyMs -->` -
so that figure's haystack is one value and its decoy pass rate is zero. A
binding that resolves and disagrees is a hard gate failure, and it is the only
check in the program that can say *this sentence contradicts the field it claims
to quote*. A binding into a bet directory not yet in this tree is PENDING: not
counted as backed, its decoys never cleared, and enforced the day the branch
lands. This document's load-bearing figures were bound on 2026-07-30, and this
document's own decoy rate fell as a result. **Over its bound subset alone the
decoys clear at 0.6%, against roughly four fifths for the figures still left
to the union index** - that gap, not the headline, is the number that shows the
mechanism working. The rest of the fall is arithmetic, since every figure moved
out of the union stops being a coin flip. The union-index remainder is what
"backed" is still worth for the figures that are not bound, and it is not much.
*(Both figures moved on 2026-08-02 from 0.7% and "roughly three quarters", for
the reason the marker below predicts rather than for any change in the
mechanism: amendments 9 to 14 added figures on both sides of the split, and a
section that measures the document it lives in moves when the document does.
The gap is the claim; neither endpoint is.)*

*Why these calibration figures moved.* An earlier revision of this section
quoted 57.5% to 91.7%, 69.0% and 43.8%. Those were real measurements of a
checker whose decoy generator was broken for exponent-form numerals: it read the
decimal count off the whole string, so a decoy for `2.19e-13` was written
`toFixed(6)` and became `0.000000`, a value most artifacts hold somewhere. Every
exponent-form figure in the program was therefore calibrated against a decoy of
zero. Fixed in PR #1897, which is why the rates fell; nothing about the corpus
changed.

<!-- numeral-src: 40%, 57.5%, 91.7%, 69.0%, 43.8%, 0.7%, 0.6% :: none - this checker's own decoy
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
     is edited. Its own bound-subset rate was quoted at 0.7% on the same
     reasoning - stable to one decimal against SMALL edits - and 2026-08-02's
     amendment round was not a small edit: it moved to 0.6%. Kept as a token
     here only so the sentence that retracts it stays checkable. The unbound
     rate is given in words for the same reason. The superseded 57.5%, 69.0%
     and 43.8% are quoted only to retract them, in the paragraph that does so.
     KNOWN DRIFT, not introduced by that round and deliberately not repaired by
     it: the prose above states the high endpoint as exact at 91.7%, and the
     checker has printed 92.9% for node-hash-v0.md since before these
     amendments. Repairing it means re-deriving what "exact only at the high
     end" is worth once the corpus grew, which is a change to this section's
     own instrument and not an amendment to the plan. -->

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
Choose one of the documented options and implement it. **The recommendation
this section used to carry - hosted episode bytes for test, deferring the salt
decision - is withdrawn, because it is refuted by the attack this bet exists to
answer.** Hosting alone withholds nothing: splits are seed arithmetic over a
public universe and `generateModel` takes no secret, so the adversary
regenerates both the corrupted model and its clean twin locally and never
requests the served bytes. Hosting is the DELIVERY channel a salt needs, not an
integrity mechanism (`benchmark/attacks/README.md`; BENCHMARK.md section 1a is
normative). What survives for a procedural corpus is a secret in the generation
path - a per-split salt mixed into **every** RNG stream, delivered by a hosted
scorer - or a different substrate (real models, which have no procedural twin
to diff against, at the cost of known-by-construction truth). Spec v1.1 has
shipped the half that needs no infrastructure: it withdraws the false claim,
labels dev attackable-by-design, cites `clean-twin-diff` as the reason, and
declares the salt model. NEITHER HALF OF THAT MODEL IS IMPLEMENTED, so the
reporting split still has no integrity property and this bet is not closed.
*Exam:* `clean-twin-diff` scores at or below the always-clean anchor on the
reporting split; spec version bumped; the attack stays committed as a
regression.
*Why it is PENDING, spelled out so no reader has to infer it.* Three things must
happen and none of them has:

1. **The integrity-model decision.** Secret per-split salt versus a real-model
   substrate is Louis's call and has not been made (hosted bytes alone is no
   longer one of the alternatives - see above). Spec v1.1 declares the salt
   model; declaring it is not deciding to build it.
2. **The implementation of whichever option is chosen.** The spec version bump
   is done; the mechanism is not.
3. **The clean-twin check re-run against it**, i.e. `clean-twin-diff` scoring at
   or below the always-clean anchor on the reporting split rather than the 1.000
   aggregate it scores today.

Until all three are done, B2.2 stays **CONFIRMED, UNFIXED** in section 1.2 and
this bet is not a Phase 4 delivery.

*Status note, 2026-08-02 (amendment 13).* Item 1 is now done: the decision is the
**secret per-split salt**, and the mechanism is being implemented. Item 2 is in
flight and item 3 has not happened, so B2.2 stays CONFIRMED, UNFIXED and this
bet stays PENDING - the decision was the cheapest of the three. The honesty half
of the spec merged as #1940 (v1.1.0: the false claim withdrawn, dev labelled
attackable-by-design, `clean-twin-diff` cited as the reason).

**What amendment 13 changes is not the decision but what follows from it.**
B6.2's public launch no longer follows from delivering the salt, because B5.2
measured two things that a salt does not touch: the benchmark never enters the
general CSG path, and both leaderboard anchors saturate the defect task once an
existing rule is wired. Salting a task set with no headroom over a code path
nobody enters protects an answer key to a question not worth asking. So this bet
keeps its exam and loses its downstream: it no longer gates B6.2 on its own.
See amendment 13 for the sequence that replaces it.

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
region-scoped permission actually needs, both clauses FAIL (24.27%, 845.6 ms).
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
`sensitivityElementGranularityClaim.verifyMs` was then 899. The wrong figure was
introduced by the commit remediating the previous round of wrong figures, in a
document the numeral checker could not then see - which is why its search root
now covers `docs/vision/**`. Corrected again 2026-08-01: B4.5 re-blessed that
scorecard when its verifier was fixed, moving the field to 845.6, and the
binding below is what caught the entry above still quoting the old value. What
that gate is and is not worth is quoted with the lane's step E9 above; the
figure is bound per-claim to the field it comes from rather than left to the
union index, which is the only reason a re-bless three days later could not
leave this sentence quietly wrong.)*

<!-- numeral-src: 845.6ms :: b45-m1-midterm/scorecard.json#sensitivityElementGranularityClaim.verifyMs -->
<!-- numeral-src: 907ms, 899 :: none - quoted only in order to retract them: 907
     is the figure this correction removed, and 899 is what the bound field held
     before the 2026-08-01 re-bless moved it to 845.6. Neither is emitted by
     anything in this tree, and a coincidental hit in the union index must not
     be allowed to vindicate either. -->

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

*Result note, 2026-08-02 (delivered, #1931).* The delta is large and the sharpest
finding is not a score. Label precision on positive defect verdicts collapses
from perfect on the synthetic dev split to zero on both foreign models, and the
defect-detection task is **not scorable** on them at all. Two structural facts
came out of it, and amendment 13 turns them into a sequence change rather than a
caveat:
- **The benchmark never enters the general CSG path.** 100% of the corpus's
  openings are rectangular through-cuts on box hosts, the `rect_fast` fast path
  takes every one of them with zero deferrals, and the exact-arithmetic boolean
  kernel - the most expensive and most failure-prone thing ifc-lite owns - is
  therefore never entered by the benchmark. Every foreign failure lives there:
  model-b's are 108 `OperandTooLarge`, concentrated on two hosts.
- **Both leaderboard anchors saturate once an existing rule is wired.**
  `baselines.mjs` hardcodes `dangling-ref: false` citing a missing
  reference-integrity rule; `computeValidationIssues` has one and it fires on
  every planted dangling reference in the corpus. Wiring it takes `oracle-kernel`
  to parity with the regex baseline, at which point the headline metric has no
  headroom left. Deliberately not fixed in that bet: changing the instrument to
  fit the input is what the bet exists not to do.

<!-- numeral-src: 100% :: b52-foreign-ifc/scorecard.json#openingsAndCsg.synthetic.openingsCutByFastPathPct -->
<!-- numeral-src: 108 :: b52-foreign-ifc/scorecard.json#openingsAndCsg.model-b.totalCsgFailures -->

**B5.3 Foreign briefs.** 30 or more M5 briefs written by people who are not the
program, three samples each, pre-registered paired CIs, tier-2 rubric.
*Exam:* infeasibility handling and repair recovery replicate on foreign briefs;
feasible-quality margin reported with its CI whatever it says.

**B5.4 B3.1 encrypted provable multiplayer (the unbuilt M4 final).**
Three clients, randomized schedules, byte-identical convergence verified by
hash exchange, server provably never holding plaintext.

**B5.5 B3.2 scan-to-parametric (the unbuilt M5 final).**
One real scanned room to parametric IFC, headline quantities within 5% of a
manually modelled reference, ~~plus one world-model scene imported with a bill
of quantities~~ **(world-model clause CUT 2026-08-02, amendment 10)**. This is
the highest-variance bet in the program and the one whose success would be least
deniable.

*Result note, 2026-08-02 (delivered, #1932).* **Partial pass.** The scan clause
is met for floor area, clear height and volume at model scale, and for every
scored quantity in one of the three rooms; it is not met for the bounding wall
surface, which is perimeter times height and is the quantity a ragged extracted
boundary punishes. The row to read first is floor area, because it is the least
deniable number the program has produced: a 3.94 GB point cloud went in and
64.726 m2 came out against a human's 64.567 m2, with no reference data touching
any stage of the extraction. The bet also carries the exam defect that motivates
instrument 8c, and that is recorded in amendment 14 rather than here.

<!-- numeral-src: 3.94GB :: b55-scan-to-parametric/scorecard.json#scan.sourceBytes -->
<!-- numeral-src: 64.726 :: b55-scan-to-parametric/scorecard.json#variants.axisAligned.totals.floorAreaM2.generated -->
<!-- numeral-src: 64.567 :: b55-scan-to-parametric/scorecard.json#variants.axisAligned.totals.floorAreaM2.reference -->

**B5.6 Adjoints through the CSG path (the M3 adjudication bet). Entered
2026-08-02, amendment 11, as Phase 5's full sixth bet against a cap raised from
five to six.**
Dual-number scalars through `subtract_many` on the opening-cut family - a host
wall plus an intersecting opening, the void pipeline as it ships - differentiating
the emitted volume with respect to design parameters.
*Exam:* agreement with central finite differences to 1e-6 relative on 95% of a
200-point seeded battery, **restricted to topology-stable neighbourhoods**,
**plus** a mandatory reported measurement across one topology-change boundary
(an opening sliding off the host edge). Both halves are load-bearing and the
restriction is declared up front on purpose:
- The restriction is what makes the exam attackable rather than
  smooth-by-construction. A CSG output is piecewise differentiable, so an
  unrestricted relative-FD criterion fails at the seams for reasons that say
  nothing about whether adjoints reach the kernel; declaring the restriction
  before the run is the difference between a scoped exam and a moved goalpost.
- The boundary row is what stops this repeating B4.4's defect. B4.4's exam was
  written on a functional its own oracle proves smooth and therefore could not
  fail (amendment 6). Here the one place the answer can be ugly is *required to
  be reported*, whatever it says, and a run that reports only the restricted
  battery is not a delivery.
*Kill clause:* **FAIL fires the pre-committed M3 downgrade** in section 8 -
derivative-free optimization over the same objectives, the B3.3 certificate
machinery retained, and the "differentiable buildings" claim withdrawn. **PASS
adjudicates M3 as BATCH-differentiable** and nothing more: interactivity is
already withdrawn by amendment 12 and is not on this exam.
*Budget:* two cycles, per `scripts/moonshot/b44-kernel-adjoint/DESIGN.md`
section 6.1. Cycle 1 answers one question - can the arrangement's derived
intersection points carry derivatives without touching the exact-predicate tier?
The tier is a fixed-width integer type with no derivative slot, but predicates
need only the primal, so this is plausible rather than hopeful. Cycle 2 makes the
subtraction output stable enough for FD to be meaningful across a cut.
**A NO in cycle 1 is a pre-committed early stop**, declared here before the run:
it terminates B5.6 at one cycle, is recorded as the bet's verdict, and fires the
same M3 downgrade a FAIL fires. It is a delivery, not an overrun, and it is what
bounds the raised cap's cost from above.
*Displacement:* **none, and the cap is therefore raised rather than held.** This
was first written as "B5.6 takes the slot freed by the retired world-model
clause", counting obligations rather than labels so that six fitted inside five.
That reading is rejected here because this document rejects it: section 9's
amendment 6 says the CSG-adjoint bet must name "which of B5.1-B5.5 it displaces
against the five-bet cap". Cutting a CLAUSE inside B5.5 frees no bet slot --
B5.5 still exists, still has an exam, still has to be adjudicated at G5. B5.1 to
B5.6 is six bets against a cap of five, and calling that five by redefining
"bet" is the kind of move this program's whole record exists to catch.

So it is recorded as what it is: **Phase 5's cap is raised from five bets to six
by amendment 11.** B5.6 is counted as a full sixth bet at full weight - two
cycles, a seeded battery with a mandatory topology-boundary row, and a kill
clause that fires the M3 downgrade - and section 7's Phase 5 row pays for it in
full rather than netting it against anything.

*Why raising it does not reintroduce the risk the cap exists to stop.* The
pre-mortem put the cap under one specific failure: a phase overcommits, the gate
holder becomes the bottleneck, and the phase delivers only its easy bets. That
is the Phase 3 failure exactly (`moonshots-execution-plan.md` section 5,
pre-mortem antidote 2, amended to match this decision). Three checkable facts
answer it here, and none of them is "B5.6 is smaller than a bet":

1. **The hard bets are already paid.** The easy-bets pattern means skipping the
   two exams that need contact outside the sandbox. Phase 5's two are B5.2 and
   B5.5, and both are already run and measured (amendment 9). The sixth bet is
   being added to a phase that has already discharged the cap's real premium,
   not to one still deferring it.
2. **It adds no gate and no ceremony.** B5.6 is adjudicated at G5 alongside the
   other five, and what it puts on the gate holder's desk there resolves to one
   binary verdict. The scarce resource the antidote rations is gate time, and
   the raise does not spend more of it.
3. **The overrun is bounded before the run.** Four of the six (B5.1, B5.2, B5.5,
   and B5.6's cycle-1 spike) are agent-buildable, and **early stop is
   pre-committed rather than discretionary**: a NO in cycle 1 terminates B5.6
   there, is recorded as the bet's verdict, and fires the same M3 downgrade a
   FAIL fires. The two-cycle budget is a ceiling, not a plan.

If that turns out to be wrong, the cap was the instrument that should have
stopped it, and this entry is where a later reader finds out it was moved on
purpose.

**Gate G5.** M4 final, M5 final **(the scan clause alone, per amendment 10)**,
B5.6's binary verdict, plus the external-validity clauses of B5.1 to B5.3.
Second standing adversarial review, mandatory.

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
The M2 final. ~~Gated on B4.3.~~ **Re-gated 2026-08-02, amendment 13: gated on a
v2 task set, and on the salt-versus-substrate decision taken once *for that
set*.** Recruiting an external lab against the current task set would spend the
one external relationship this program gets on tasks two baselines saturate and
a code path the tasks never enter. The order is: rebuild the task layer, take
the integrity decision for v2, then recruit.

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
substrate, and the M3 act is a **batch** descent with a certificate stream
rather than a live relaxation (amendment 12).

*Scope added 2026-08-02 (amendment 10): the world-model import lands here.* One
generated world-model scene is imported and grounded to parametric IFC inside the
demo's M5 act. Its boundary is stated here so it cannot drift back into being an
exam: it is a **stage artifact**, judged only on whether the act runs on stage.
It carries no pass/fail bar, no number of its own, and no G6 clause; if it does
not run, B6.5 drops the act and nothing in M5's final exam moves, because
amendment 10 cut it from that exam. Reviving it as an exam clause requires a
falsifiable bar - a reference quantity set a generated scene can miss - per
negative-results ledger entry N6 in `moonshots-execution-plan.md`.

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
| 5 | 8-10 | 3 (gate) + 1 (brief recruitment) + 1 (scan capture) | model budget for B5.3; scanner access or one purchased scan |
| 6 | 5-6 | 5 (gate) + paper writing + external lab outreach + open-sourcing decision on provenance | hosting for the benchmark scorer |

*Phase 5's row was 6-8 and moved 2026-08-02 (amendment 11): B5.6 is a two-cycle
bet that displaces nothing, so its two cycles are added rather than exchanged.
This row is the cost side of the raised cap, and it is meant to be visible here
rather than absorbed: six bets, six bets' worth of cycles. The retired
world-model clause (amendment 10) frees nothing to net against, because it was
never separately budgeted in the first place. The line under section 5 that
says a NO in B5.6's first cycle is a delivery is what keeps the upper end from
being the expected case.*

Roughly 17 to 21 agent-cycles over about 8 months. As before, agent-cycles are
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
  **Attached 2026-08-02 (amendment 11): that bet now exists and is B5.6.** The
  downgrade clause above is its FAIL branch verbatim; its PASS branch adjudicates
  M3 as BATCH-differentiable only. **M3's INTERACTIVITY claim is separately and
  deliberately withdrawn (amendment 12) and is no longer any part of what B5.6
  can win back.**
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
  is withdrawn regardless of B4.4's outcome. **FIRED 2026-08-02, deliberately
  and ahead of G5 (amendment 12). M3's INTERACTIVITY claim is WITHDRAWN.** M6b
  itself is not killed: it stays a validated but UNWIRED lever with the dated
  re-entry condition in that amendment. Firing a kill clause early, on evidence
  already in the ledger, is the clause working; waiting for G5 to fire it
  automatically would only have bought four more months of saying it.

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
  **Closed 2026-08-02: #1897 merged 2026-08-01 by the repo-owner account, so
  amendments 6 to 8 are the signed record. Checkable with `gh pr view 1897`.**
- Nothing in Phase 4 has passed sign-off as of this writing: #1886, #1897,
  #1899, #1900 and #1902 are all open. A gate cannot close on unmerged branches,
  which is a second, independent reason G4 stays failed.
  **Corrected 2026-08-02: all five have since merged, so this second reason no
  longer applies. G4's status is unchanged and stays FAILED on the first reason
  alone - amendment 8's three grounds, of which B4.3's non-delivery is still
  live. A sign-off condition being met is not a gate passing, and this bullet is
  corrected rather than deleted so that distinction stays legible.**
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
   **SUPERSEDED in part 2026-08-02 by amendment 11**, which entered the bet as
   B5.6 with all five things listed above. The displacement statement it
   demanded came back **none**, and the "five-bet cap" this paragraph names was
   raised to six for Phase 5 rather than fitted into; that sentence is the
   requirement as written on 2026-07-29, not the standing cap.
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

**Added 2026-08-02, at the Phase 5 betting table.** Six entries. Five are the
decisions the betting table took now that Phase 4's bets have merged and the two
bets Phase 3 skipped have been run; the sixth adds an instrument, which is a
change to section 2 and therefore belongs here too.

*A note on the status of amendments 6 to 8, because section 9.1 makes it
checkable rather than assertable: **they are no longer PROVISIONAL.** #1897 was
merged by the repo-owner account on 2026-08-01, which is the signature act
section 9.1 names, so amendments 6, 7 and 8 are the signed record. Verify with
`gh pr view 1897`. The same rule applies to what follows: **amendments 9 to 14
are PROVISIONAL** until the docs PR carrying branch
`docs/moonshot-amendments-phase5` is merged by the repo-owner account. No PR
number is written here because none exists at authoring time, and section 9.1
forbids a sentence claiming sign-off that names nothing a reader can check.*

9. **Phase 4's bets have merged, `node-hash-v0` is frozen, and section 1.1's
   survivorship pattern has its first counter-evidence. Phase 4's verdict is
   unchanged.** Recorded once, here, in three parts.

   (a) *Merged.* B4.1 (#1897), B4.2 (#1900), B4.4 (#1902) and B4.5 (#1899) are
   on main, and B4.3's honesty half merged as #1940. **`node-hash-v0` is FROZEN
   at `1.0.0` (#1886)**, which is the prerequisite section 10 names for making
   `@ifc-lite/provenance` public: freezing the wire format is what makes a
   compatibility promise mean anything.

   (b) *Both bets Phase 3 skipped have been run, and measured on data the
   program did not author.* B5.2 (#1931) put the benchmark's tasks and the
   defect detector against two real externally authored AEC models this program
   neither authored nor had seen. B5.5 (#1932) took one real laser scan of an
   occupied dwelling through extraction, parametric emission and the kernel, and
   scored it against a manually modelled reference. Section 1.1 calls the
   skipping of exactly these two "a survivorship pattern, not a schedule
   accident, and the single most important fact in this document". **This is the
   first evidence against that fact**, and it is the only such evidence the
   program has: the two exams that require contact with something outside the
   parametric sandbox were not deferred a second time, and neither produced a
   number this program controlled. Their results are in section 5's two result notes and in
   amendments 10, 13 and 14.

   (c) *And none of it moves Phase 4.* **Phase 4 stays recorded FAILED on its own
   terms** (amendment 8). All three of that amendment's grounds are untouched:
   B4.4's exam was written on a functional its own oracle proves smooth, the M4
   delete-clause was evaluated only under the op model that manufactures the
   rule's catches, and B4.3 was not delivered - it still is not, because the
   decision is not the mechanism. **B2.2 remains CONFIRMED, UNFIXED**: the salt
   is decided and being built, and `clean-twin-diff` has not been re-run against
   anything. A phase is not retroactively passed by the phase after it, and one
   broken pattern is not a retired one.

10. **B5.5's world-model clause is CUT. The M5 final is the scan clause alone.**
    The M5 final in `moonshots-execution-plan.md` section 2 reads "one real
    scanned room to parametric IFC with headline quantities within 5% of a
    manually modeled reference, **plus one world-model scene imported with a bill
    of quantities**". The second half is retired before it was built, and the
    reasons are written out so the decision can be argued with:

    (a) **It shares no machinery with the scan path it was bundled into.** The
    scan clause is point-cloud ingest, plane fitting, room extraction,
    parametric emission and kernel measurement. A world-model import shares none
    of those stages; it was one bet because both were "M5 inputs", not because
    either helped the other.
    (b) **It has no exam.** Its whole stated bar is that a bill of quantities
    exists. Nothing in it can come back FAIL, which is precisely the defect
    amendment 8 records against Phase 4 and precisely what instrument 8 is being
    added to prevent. A clause that cannot fail must not be carried as a final
    exam clause.
    (c) **It is the one clause in the program that is trend-chasing rather than
    thesis-bearing.** The thesis is "neural systems propose, the kernel
    disposes". Grounding a generated scene demonstrates the proposing half, which
    is the half the rest of the world is already funding. Nothing about the
    kernel's claim depends on it.
    (d) **The clause it was bundled with has already produced the program's
    least deniable number**, and it did so without any help from the world-model
    half: a 3.94 GB point cloud in, 64.726 m2 out against a human's 64.567 m2,
    reference data touching no stage of the extraction.

    The story is not deleted, it is re-sited: **the world-model import moves to
    B6.5's demo**, where a generated scene is a stage artifact and is judged as
    one, rather than an exam clause pretending to be measurable. B6.5's entry in
    section 5 names the work and states its boundary, so the move is a contract
    and not a gesture: it sits in the demo's M5 act, has no pass/fail bar, no
    number of its own and no G6 clause, and the act is dropped if it does not run.
    Negative-results ledger entry N6 in `moonshots-execution-plan.md`.

11. **B5.6 enters the Phase 5 betting table: adjoints through the CSG path.**
    Amendment 6 left M3 UNADJUDICATED and stated exactly what entering this bet
    would require: "a number, an exam, a kill clause, a statement of which of
    B5.1-B5.5 it displaces against the five-bet cap, and a cycle-budget update.
    None of those exist yet." All five exist now. The bet's full entry is in
    section 5 and is not duplicated here; what this entry records is that the
    betting-table act happened, and its four load-bearing parts:

    - **Exam.** Adjoints through `subtract_many` on the opening-cut family - a
      host wall plus an intersecting opening, the void pipeline as shipped -
      FD-matched to 1e-6 relative on 95% of a 200-point battery **restricted to
      topology-stable neighbourhoods**, **plus a mandatory reported measurement
      across one topology-change boundary** (an opening sliding off the host
      edge). The restriction is declared before the run because that is what
      makes the exam attackable instead of smooth-by-construction, and the
      boundary row is required because without it this bet repeats B4.4's
      could-not-fail defect on a harder functional.
    - **Kill clause.** FAIL fires the section 8 M3 downgrade: derivative-free
      optimization over the same objectives, B3.3's certificate machinery
      retained, "differentiable buildings" withdrawn. PASS adjudicates M3 as
      **BATCH-differentiable**, which is what is left of the claim after
      amendment 12.
    - **Budget.** Two cycles, per `scripts/moonshot/b44-kernel-adjoint/DESIGN.md`
      section 6.1. Cycle 1 answers whether derived intersection points can carry
      derivatives without touching the exact-predicate tier - plausible, because
      predicates need only the primal, while the tier itself is a fixed-width
      integer type with no derivative slot. **Reaching a NO in cycle 1 is the
      verdict, not a failure to deliver.** Section 7's Phase 5 row moves from 6-8
      to 8-10 agent-cycles.
    - **Displacement: none, and the cap is therefore raised rather than held.**
      B5.6 displaces nothing. Cutting a clause inside B5.5 (amendment 10) frees
      no bet slot: B5.5 still exists, still has an exam, still has to be
      adjudicated at G5. So **Phase 5's cap is raised from five bets to six by
      this amendment**, for Phase 5 only, and **B5.6 counts as a full sixth bet**
      - two cycles, its own exam, its own kill clause - not as a fraction of one.
      The justification is checkable rather than rhetorical, and it is about who
      pays rather than about the bet being small: Phase 5's two hardest bets
      (B5.2, B5.5) are already run and measured, four of the six are
      agent-buildable, the sixth adds no gate and no ceremony because it is
      adjudicated at G5 with the rest, and a cycle-1 NO is a pre-committed early
      stop that bounds it at one cycle. The full argument, including why counting
      exam obligations instead of labels would have been a redefinition rather
      than a fit, is in section 5's B5.6 entry, so a later reader can reject the
      raise rather than discover it. Section 7's Phase 5 row is where it is paid
      for, and `moonshots-execution-plan.md` section 5's pre-mortem antidote 2
      carries the matching exception so the two documents cannot be read as
      disagreeing about the cap.

12. **M6b's interactivity kill clause is FIRED, deliberately, now. M3's
    INTERACTIVITY claim is WITHDRAWN.** Section 8's M6b clause reads "if it is
    not wired into production by G5, M3's interactivity claim is withdrawn
    regardless of B4.4's outcome". The clause is fired at the betting table
    rather than left to trip at G5, on evidence that has been in the ledger for
    ten days:

    - **N4**, in the negative-results ledger: threaded wasm measured at 0.87x on
      the full pipeline, an atomics tax rather than a speedup, re-refuted
      2026-07-23. M6b's own range is a **CSG-stage** figure and N4 says in as
      many words that it must not be restated as an end-to-end one.

      <!-- numeral-src: 0.87x :: none - the threaded-wasm whole-pipeline figure
           from the repo's own perf program, recorded in this plan set as ledger
           entry N4. It pre-dates the moonshot program and nothing under
           scripts/moonshot/ emits it, so it is blocked for the same reason
           M6b's 2.9x-4.2x range is: a coincidental hit in the union index must
           not be allowed to read as provenance for a figure produced somewhere
           else entirely. -->

    - **The memory-bandwidth finding**, in `scripts/perf/README.md`'s dead-ends
      list: more geometry workers give zero CSG speedup because the path is
      memory-bandwidth bound, not CPU bound. A lever whose parallel scaling is
      bounded by bandwidth does not become an interactivity story by being
      wired.

    Together those say the projection budget M3's interactivity claim needs is
    not reachable by threading, and M6c already removed the GPU from that story
    (amendment 2). Waiting for G5 to fire the clause automatically would have
    bought four more months of saying a thing the program's own measurements
    contradict. **This is a deliberate withdrawal, not a failure discovered
    late**, and the distinction is the whole point of writing it down: nothing
    new was measured, a conclusion already available was acted on.

    **M6b is not killed.** It stays a validated but **UNWIRED** lever, TRL 5,
    with a dated re-entry condition: *re-enter M6b when a workload shape changes
    the atomics arithmetic* - a CSG stage whose per-element work is large enough
    that the atomics tax amortizes, or a path whose bottleneck is measured to be
    arithmetic rather than bandwidth. Re-entry requires that measurement first,
    per the ledger's resurrection rule. Recorded as N5 in
    `moonshots-execution-plan.md`.

    **What M3 keeps.** B5.6 adjudicates M3 as batch-differentiable. That is
    publishable on its own terms - a projection operator with exactness
    guarantees is the piece the differentiable-simulation field lacks, and it is
    what certified descent needs - and it is a smaller claim than the one this
    plan has been carrying. The demo that follows a PASS is a batch optimization
    with a certificate stream, not a building relaxing live in a tab.

13. **B4.3 and B6.2 are re-sequenced. The salt decision stands; the public
    launch does not follow from it.** The decision recorded in first-moves item 2
    is taken - **secret per-split salt** - and the mechanism is being
    implemented. What amendment 13 changes is what that unlocks, on B5.2's own
    committed report:

    - **The benchmark never enters the code path where the failures are.** 100%
      of the corpus's openings are rectangular through-cuts on box hosts and the
      `rect_fast` path takes every one of them with zero deferrals, so the
      general CSG path - "the most expensive and most failure-prone thing
      ifc-lite owns" - **is never entered by the benchmark at all**, while every
      foreign failure lives there (model-b's 108 `OperandTooLarge`).
    - **Both anchors saturate once the reference-integrity rule is wired**, which
      leaves the headline metric with no headroom to measure anything with.

    A salt protects an answer key. Neither of those findings is about the answer
    key. So:

    (a) **B2.2 stays CONFIRMED, UNFIXED and dev stays attackable-by-design.**
    Nothing here weakens the finding or the label.
    (b) **The task layer is rebuilt first.** Defects re-substrated onto real
    models, which have no procedural twin to diff against, plus generator
    families that actually enter the general CSG path (non-rectangular openings,
    diagonal cuts, many-opening hosts - the shapes both foreign models are full
    of and the corpus has none of).
    (c) **The salt-versus-substrate decision is taken once, for the v2 task
    set.** Taking it against v1 would be building integrity machinery for tasks
    about to be replaced, and the v2 substrate choice may itself answer it: a
    real-model substrate has no clean twin to regenerate.
    (d) **B6.2 recruits against v2.** A lab post-training against tasks that two
    baselines saturate, on a corpus that never enters the kernel's hard path,
    would burn the one external relationship this program gets and would produce
    a result nobody could interpret. External-lab recruitment is a
    one-shot human-calendar item; it is sequenced last on purpose.

14. **Instrument 8 is added to section 2: exam integrity.** The three clauses are
    written in section 2. This entry records what they reach, because an
    instrument sold as more than it is becomes the next thing to audit.

    **8a and 8b are retrospective on real defects, and would have caught these:**
    the forged trust anchor and the crafted-size allocation cap in B4.5's bundle
    verifier; the FIFO cap bypass that re-opened that same allocation defect
    through a different door two rounds later; B5.2's bodyless
    `degenerate-geometry` verdict, taken from meshes coming back empty rather
    than from following the mapping that would say whose fault it was, and its
    `Unknown` representation-item histogram, which had exactly one reachable
    value and so could not have distinguished anything; B4.4's harness ignoring
    cargo's exit code and discarding deviations; and the shared-temp-dir race
    that produced a PASS. Every one of those is a verdict that could not have
    come back FAIL, or a verdict taken from an absence.

    **They would NOT have caught B5.5's blind exam, and the honest version of
    this instrument says so.** That scorer ran, it passed, and it was *correct
    about what it measured*. The defect was not in the scorer; it was in the
    invariance group. Every scored quantity is an `IfcSpace` quantity - floor
    area, clear height, volume, bounding wall surface - and all four are
    invariant under a rigid Z shift of the walls and slab. The first revision of
    the emitted model put the walls and the slab a whole storey low, because
    `addIfcWall` and `addIfcSlab` place relative to the storey while `addIfcSpace`
    places relative to the world, so handing all three the fitted floor plane
    (-1.37 m) applied it twice. Not one scored row moved by a digit. A red-run
    would have gone red for the violation it was written for; a positive
    assertion would have asserted the quantity it was written for. **Only 8c
    reaches this**, because only 8c asks what the score is blind to *before*
    the run.

    <!-- numeral-src: -1.37 :: b55-scan-to-parametric/scorecard.json#scan.planes.floor.z -->

    **And the cheap backstop, recorded because it is embarrassing and true:
    render one elevation image per emitted model and look at it.** The defect was
    a storey's worth of separation between a room and the walls bounding it. It
    was visible in a single screenshot. This program has built a Merkle DAG, a
    GPU predicate library and a numeral-provenance gate, and has never once
    looked at a picture of what it emitted. Every bet that emits a model owes one
    rendered view in its directory, and 8c owes it a place in the audit.

---

## 10. Agent-buildable versus human-only, updated

**Parallel track (agents, no permission blocking):** the CI lane, coupled merge
semantics, the adjoint spike, the M1 midterm run, encrypted multiplayer
plumbing, scan-to-parametric pipeline, foreign-IFC scoring runs, browser demo,
paper drafts, all documentation.

**Serial human calendar (the real schedule), with the new items marked:**

- Benchmark integrity model decision (B4.3). ~~**Blocking Phase 6.**~~ **Taken
  2026-08-02: secret per-split salt; the mechanism is in implementation. What
  now blocks Phase 6 is not this decision but the v2 task set and the
  salt-versus-substrate call taken once for it (amendment 13), and that call may
  be answered by the substrate choice rather than made separately.**
- **NEW: making `@ifc-lite/provenance` public and non-prototype.** Blocking
  finish line C. Note that the spec-freeze PR (#1886), which stamps
  `node-hash-v0` at 1.0.0 and bumps the package to 0.1.0, ~~is itself still open
  and~~ is a prerequisite: freezing the wire format is what makes a public
  package's compatibility promise meaningful. **#1886 merged 2026-08-01, so the
  prerequisite is met and this item is now the decision alone.**
- **NEW: recruiting the outside.** Foreign brief authors, a foreign IFC source,
  and an adversarial reviewer with no authorship stake. Blocking Phase 5.
  **Partly done 2026-08-02: the foreign IFC source arrived and B5.2 ran on it.
  Foreign brief authors and the G5 reviewer are outstanding, and amendment 14
  adds a second thing the reviewer must be named early enough to do - the 8c
  null-space audit, which is a commissioning-time act.**
- **NEW: one real scan.** Access to a scanner or a purchased scan plus a
  manually modelled reference. ~~Blocking B5.5.~~ **Done 2026-08-02: both the
  scan and the reference arrived and B5.5 ran (#1932). This item is closed.**
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

This list is the outstanding blockers as of 2026-08-02, not the list this
section shipped with and not the 2026-07-30 revision of it. Rewriting rather
than ticking is deliberate: a stale "do this first" list is the same defect
class as a stale figure.

*What the previous revision listed, and where it went.* #1897 merged
2026-08-01, so amendments 6 to 8 are signed and item 1 is closed. The B4.3
decision is taken (secret per-split salt) and its mechanism is in
implementation, so item 2 becomes a narrower item below. Two of the three
external-data prerequisites arrived - a foreign IFC source and one real scan
with a manually modelled reference - which is what let B5.2 and B5.5 run; real
collaboration traces and foreign brief authors did not, and survive below. The
Phase 5 betting table sat, and its output is amendments 9 to 14, so item 4 is
closed. Item 5 was not done and is unchanged.

In order:

1. **Merge this document's PR.** Section 9.1 defines gate-holder sign-off as the
   merge of the gate's docs PR by the repo-owner account, so this merge is what
   converts amendments 9 to 14 from proposed to signed. Nothing downstream of
   them is settled until it happens, and no agent can perform or fake it.
2. **The two external-data prerequisites that did not arrive**, both lead-time
   human items: real multi-user collaboration traces (B5.1) and foreign brief
   authors (B5.3). These are now the only things standing between Phase 5 and a
   complete external-validity set; the other two arrived and delivered.
3. **Name the G5 adversarial reviewer before Phase 5's work finishes**, on the
   same logic that made G4 worth commissioning: a reviewer named afterwards
   reviews a record that has already hardened. **Amendment 14 adds a second
   thing to commission early** - instrument 8c's null-space audit is a
   commissioning-time act, so the reviewer who does it must be named before
   B5.6 and B5.1 run, not after.
4. **The v2 task-set decision for the benchmark** (amendment 13): what the
   defects are re-substrated onto, and which generator families are added to
   make the corpus enter the general CSG path. This is the item B6.2 now waits
   on, and the salt-versus-substrate call is taken inside it rather than before
   it.
5. **External lab recruitment stays parked** until item 4 lands. It is a
   one-shot relationship and recruiting against a saturated task set spends it
   for nothing.

Item 1 unblocks the record; item 2 is the only remaining thing nobody inside
the program can do; item 4 is what the whole M2 line now waits on.
