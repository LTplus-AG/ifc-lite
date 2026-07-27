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
- Per-op dispatch, which is the batch shape today's kernel structure naturally
  produces, sinks to 0.8x to 1.1x on three of five models.

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

TRL 4 to 5 across the board, with one shipped surface. That is a genuinely
strong six-month position and it is not TRL 7 anywhere, which is what "finished"
would require.

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
  to the quantity the evidence does support: correct behaviour at the
  infeasibility boundary and guaranteed recovery under held-out rules, both
  with pre-registered paired CIs.
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
turns it red and names which act broke.

**B4.2 Spatially coupled merge semantics (closes the B2.1 finding).**
Give the op model semantics that can fail: hosted openings must remain inside
their host wall, `geometry-replace` triggers a re-cut, ops can be rejected on
spatial grounds. Re-run the 1,000-schedule battery.
*Exam:* false-conflict rate restricted to schedules where the spatial rule
fired, reported against the < 20% bar, with the count of spatial-only **true**
conflicts stated explicitly.
*Binary consequence:* if the spatial rule still yields zero true conflicts under
coupled semantics, delete the rule and say so in the ledger. A predicate that
never fires truthfully is not a contribution.

**B4.3 Benchmark integrity v1.1 (closes the B2.2 finding; human decision).**
Choose one of the three documented options and implement it. Recommendation, for
the record and subject to the betting table: **hosted episode bytes for test,
dev left open and explicitly labelled attackable-by-design, with
`clean-twin-diff` cited in the spec as the reason.** This preserves local
iteration, stops the spec claiming an integrity property it does not have, and
defers the salt decision until a hosted scorer exists.
*Exam:* `clean-twin-diff` scores at or below the always-clean anchor on the
reporting split; spec version bumped; the attack stays committed as a
regression.

**B4.4 The M3 kernel-adjoint spike (binary).**
A dual-number scalar type through the mesher for the rectangular-extrusion
family, differentiating divergence-theorem volumes.
*Exam:* as section 4. Two cycles' worth of risk compressed into one; if it needs
more than one cycle to reach a verdict, that is itself the answer.

**B4.5 The M1 midterm as worded.**
Mesh-bearing DAG at 169 MB scale, both halves in one run.
*Exam:* under 500 ms verification, under 5% of nodes resolved, over 90% cache
hits on single-wall recompute, with real mesh leaves present throughout.

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
- **M3:** B4.4 is binary. Fail means the pre-committed downgrade to
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
- Every merge to main.

---

## 11. First moves

In order, this week:

1. **B4.1.** Write `moonshot.yml`. Half a day of work protecting eight months
   of results. Right now a single kernel change could silently falsify every
   headline in the program and nothing would say so.
2. **Amendments 1 to 5** into `moonshots-execution-plan.md`. Ten minutes each,
   and they stop the record hardening around claims the evidence has already
   outrun.
3. **B4.3 decision.** One paragraph from you unblocks Phase 6.
4. **Schedule the Phase 4 betting table** and name the adversarial reviewer for
   G4 at the same time, so the review is commissioned before the work it will
   attack is finished.

The order matters. Item 1 makes everything already achieved durable, item 2
makes it honest, and items 3 and 4 are the two things nobody else can do.
