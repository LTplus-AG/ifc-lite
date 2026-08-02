# Moonshots execution plan

Written 2026-07-24. Companion to [moonshots-tech.md](./moonshots-tech.md). That document says
what and why; this one says how, in what order, with what proof at every step.

## 0. The framework, and why this one

Research programs and product roadmaps fail differently. A product roadmap fails by shipping
the wrong thing; a research program fails by never being falsifiable. The plan below borrows
the four best-established tools for keeping ambitious technical programs honest, one per
failure mode:

1. **The Heilmeier Catechism (DARPA)** as the per-moonshot planning unit. Every moonshot must
   answer the eight questions: what are you trying to do, how is it done today, what is new,
   who cares, what are the risks, what does it cost, how long, and what are the midterm and
   final exams. If a moonshot cannot answer question 8 with a number, it is not plannable.
2. **DARPA phase structure with TRL grading and go/no-go gates.** The program runs in phases;
   each phase ends in a gate with pre-committed pass criteria. Technology Readiness Levels
   (TRL 1 = principle observed, 9 = proven in operation) give an honest map of where each
   moonshot actually stands today, which is the antidote to the demo-driven illusion of
   progress.
3. **Shape Up cycles (6 weeks, betting table)** as the execution cadence. Already the house
   method. Phases are made of cycles; at each betting table, bets are placed against the gate
   criteria of the current phase, and unfinished work does not roll over by default.
4. **X-style kill criteria (pre-mortems).** Each moonshot carries explicit conditions under
   which it dies, decided now while nobody is attached to sunk cost. Killed moonshots get an
   entry in the negative-results ledger (scripts/perf/README.md precedent) so they are not
   accidentally re-spiked in a year.

One structural lesson is imported from the 2026-07 model-checking program: **the plan is a
parallel agent-build track plus a serial human calendar, and the human calendar is the real
schedule.** Agents can build kernels, corpora, and verifiers in parallel; they cannot publish
papers, hold signing keys, negotiate with labs, or accept merges. Section 6 keeps that ledger
honest.

## 1. Program map

### Dependency graph

```text
M6 (speed)  ──────────────┐
                          ▼
M1 (hashes, certificates) ──► M4 (provable merges)
      │                       
      ├──────────► M2 (gym, corpus) ──► M5 (grounding compiler)
      │                                       ▲
      └──► M3 (differentiable, needs M6) ─────┘ (shares objective/validity machinery)
```

M1 is the root and goes first. M6 is a background thread that starts immediately because its
cheapest lever is blocked on external timing (browser engines implementing the opcodes),
its middle lever is wiring work,
and its research lever (GPU predicates) has the longest lead time. M2 starts as soon as M1's
hash spec is stable, because rewards are certificates. M4 follows M1. M3 and M5 are Phase 2+
research that consume everything before them.

### Where each moonshot stands today (honest TRL)

| Moonshot | Today | TRL | Basis in repo |
|---|---|---|---|
| M1 Proof-carrying buildings | components exist, no unified spec | 3 | per-mesh FNV manifests, content-addressed blob store (collab/geometry), RTC-invariant diff fingerprints, predicate-sign manifest |
| M2 World Gym | ingredients exist, no generator/env loop | 2-3 | packages/create (walls/slabs/beams/columns/stairs/roofs), headless CLI/MCP, IDS/clash/quantities as checks, drawing-2d labeling |
| M3 Differentiable buildings | idea + columnar substrate | 1-2 | TypedArray data plane, parametric create path; no adjoints anywhere |
| M4 Provable merges | strong engineering base, no soundness contract | 3 | packages/merge three-way/rebase/inverse + real-model fuzz, CSG-op CRDT array, E2E encryption |
| M5 Grounding compiler | prior art validated externally, nothing local | 2 | MCP/SDK give the kernel-in-the-loop surface; Zero-to-CAD/GIFT prove the recipe elsewhere |
| M6a wasm wide-arithmetic | measured, blocked on V8 opcode support | 6 | docs/architecture/wasm-wide-arithmetic.md: 1.71x e2e measured |
| M6b threaded CSG | validated, not wired | 5 | docs/architecture/csg-threading-design.md: 2.9-4.2x CSG-step |
| M6c exact predicates on GPU | untested principle | 1 | predicate cascade well-factored in kernel/predicates.rs; nothing on GPU |

<!-- numeral-ok: 1.71x :: the wasm wide-arithmetic end-to-end speedup, measured by
     docs/architecture/wasm-wide-arithmetic.md and its benchmark, not by any
     scripts/moonshot artifact. Cited here, produced elsewhere. -->

## 2. Heilmeier catechism per moonshot

Format: the eight answers, compressed. Costs are in agent-cycles (one focused Shape Up bet by
an agent team) plus named human time, because that is the actual currency here.

### M1. Proof-carrying buildings

1. **Objective:** every model state a Merkle DAG of content-addressed nodes; every change a
   certificate (inputs read, outputs produced, invariants claimed) that any browser can verify
   by deterministic replay of the affected subtree.
2. **Today:** BIM changes are trusted, not verified; audit = human review of exports. Even git
   LFS style CAD versioning hashes files, not semantics.
3. **New and why now:** byte-determinism across platforms makes replay verification sound; the
   repo already hashes meshes, blobs, and diffs, so the DAG is unification work, not invention.
4. **Who cares:** agentic-BIM (delegation with proofs), insurers/authorities (audit),
   distributed teams (trustless review), every other moonshot (it is their trust root).
5. **Risks:** hash instability across kernel versions (mitigate: version the trust root with
   the predicate-sign manifest; certificates pin kernel version); certificate spec creep
   (mitigate: v0 = three claim types only: subtree-untouched, hash-equality, scalar-delta);
   recompute granularity too coarse to be useful (mitigate: measure cache-hit rate on real
   edit traces early).
6. **Cost:** 3-4 agent-cycles to v1; human: spec review, trust-root key custody decision.
7. **Time:** hash spec + certificate v0 in Phase 0; memoized recompute in Phase 1.
8. **Exams.** Midterm: a wall edit on a 100 MB model yields a certificate a second browser
   verifies in < 500 ms while re-reading < 5% of DAG nodes. Final: an agent edit made under a
   region-scoped permission is verified by a third party who never downloads the full model;
   single-wall edit achieves > 90% node-level cache hits on recompute.

### M2. The World Gym

1. **Objective:** a procedural generator + deterministic labeler producing unbounded IFC with
   perfect ground truth, wrapped as a gym (reset/step/reward) and a public browser-runnable
   benchmark.
2. **Today:** RLVR gyms exist for math/code/computer-use; AEC models train on scraped or
   proprietary data with no verifiable rewards; Autodesk cannot publish its corpus.
3. **New:** the kernel is a millisecond-scale, embarrassingly parallel, deterministic oracle;
   every shipped check (IDS, clash, quantities, schema) doubles as a reward channel; drawing-2d
   gives paired 3D-drawing modalities for free.
4. **Who cares:** every lab post-training agents (environment scarcity is their stated
   bottleneck), academia (benchmark), ifc-lite itself (M5 trains on it).
5. **Risks:** realism gap, synthetic buildings too regular to transfer (mitigate: grade the
   corpus against distribution statistics of the real fixture corpus; augment-real pivot as
   fallback); reward hacking (mitigate: adversarial red-team bets against the reward set each
   phase); generator breadth limited by packages/create element coverage (mitigate: corpus v1
   scopes to the covered families, breadth is a ratchet not a gate).
6. **Cost:** 4-6 agent-cycles to benchmark launch; human: benchmark governance, outreach to
   one external lab, licensing decision (corpus should be permissively licensed).
7. **Time:** gym API v0 in Phase 1, corpus v1 + benchmark in Phase 2.
8. **Exams.** Midterm: 100k generated models, 100% labeled, labels spot-validated against the
   IfcOpenShell differential oracle, five reward channels behind one env API. Final: one
   external group post-trains a model on the gym and improves measurably on a held-out split;
   leaderboard runs the verifier client-side.

### M3. Differentiable buildings

1. **Objective:** gradients of physical/regulatory objectives with respect to design
   parameters, with the exact kernel as validity projection after every step, certificates on
   every intermediate state.
2. **Today:** generative massing tools explore; optimization is genetic/heuristic; validity is
   checked after the fact, not enforced during descent.
3. **New:** columnar plane is tensor-shaped already; the projection operator (exact kernel)
   exists, which is the piece differentiable-simulation groups lack.
4. **Who cares:** computational design, carbon/energy compliance, the differentiable-physics
   research community (a projection operator with exactness guarantees is publishable alone).
5. **Risks:** the CSG/void path is only piecewise-differentiable and adjoints through it may be
   intractable (this is the kill risk, see section 5); performance of per-step projection
   (depends on M6).
6. **Cost:** 1 spike cycle + 3-4 cycles if the spike passes; human: pick the flagship objective
   (embodied carbon is the suggestion) and review the math.
7. **Time:** spike in Phase 2, demo in Phase 3.
8. **Exams.** Midterm (spike gate): analytic gradients of quantities/carbon w.r.t. parameters
   of created elements match finite differences to 1e-6 on 95% of a randomized battery, and
   one 20-parameter optimization converges to a valid certified state. Final: browser demo,
   multi-objective descent, projection + certificate < 200 ms per step on the flagship model.

### M4. Convergence you can prove

1. **Objective:** merges emitted only with commutation certificates; conflicts are exact
   geometric predicates (region-hash intersection) rather than timestamps; end-to-end theorem:
   replicas agreeing on the op log agree on the model bytes; all of it surviving E2E
   encryption (server-blind).
2. **Today:** collaborative CAD merges are last-write-wins, locks, or human review; no system
   states a convergence guarantee over geometry.
3. **New:** CRDT convergence (Yjs) composed with kernel determinism yields the theorem
   almost for free; packages/merge already computes three-way plans; M1 provides footprints.
4. **Who cares:** distributed/multi-firm projects, agent swarms editing concurrently (M2/M5
   consumers), the local-first research community (FOSDEM track material).
5. **Risks:** footprint over-approximation makes everything conflict (mitigate: measure
   conflict precision on real edit traces; tighten regions iteratively); op-log semantics vs
   current Y.Map state sync (mitigate: scope theorem v1 to the CSG-op CRDT array + layer ops,
   not arbitrary Y mutations).
6. **Cost:** 3 agent-cycles; human: none beyond review until the encrypted flagship demo.
7. **Time:** Phase 2.
8. **Exams.** Midterm: soundness property test, 1,000 randomized two-client op schedules,
   zero unsound auto-merges (an auto-merge whose replay differs from sequential application),
   with conflict rate reported. Final: encrypted session, server provably never holds
   plaintext, three clients converge byte-identically across randomized schedules, verified by
   hash exchange.

### M5. The grounding compiler

1. **Objective:** neural front-ends emit programs over the kernel, decoded under constraint
   with per-op geometric feedback; outputs are parametric IFC + certificate, never mesh soup.
   Inputs: text/sketch first, splat scan second, world-model import third.
2. **Today:** text-to-CAD one-shots CadQuery; scan-to-BIM ships meshes needing manual
   parametrization; world models output radiance fields with no semantics.
3. **New:** the validator runs in the same wasm as the sampler (client-side, per-op feedback at
   interactive rates once M6 lands), and M2 provides unlimited paired training data.
4. **Who cares:** the entire capture/design tool market; strategically, it makes every
   world-model vendor a potential upstream rather than a competitor.
5. **Risks:** this is where incumbent competition is hottest (mitigate: compete on the
   verifier + open corpus, treat models as swappable); splat-to-parametric accuracy plateau
   (see kill criteria); scope explosion (mitigate: the op vocabulary is packages/create's
   element families, nothing more, until the final exam passes).
6. **Cost:** 4-6 agent-cycles across two phases; human: model access/budget decisions,
   evaluation taste.
7. **Time:** constrained-decoding harness in Phase 2 (it is M2's gym pointed at generation),
   scan input in Phase 3.
8. **Exams.** Midterm: 100% of emitted programs compile by construction (invalid ops
   unreachable at decode time), quality scored on the M2 benchmark, beats unconstrained
   baseline of the same base model by a wide, stated margin.
   **AMENDED 2026-07-26 (betting table, amendment 1 of moonshots-finishing-plan.md
   section 9).** The "wide, stated margin" clause is replaced by: correctly handles
   infeasible briefs at a rate exceeding budget-matched baselines, and recovers from
   held-out-rule violations, both with pre-registered paired CIs, with feasible-brief
   quality reported as a null result. Rationale: two tiers and one fresh-sample
   replication support the amended quantity and not the original. Tier-1 was
   instrument-limited (saturated rubric, validator rules serialized into the prompt).
   Tier-2 held five rules out of prompts, proved rubric headroom (mediocre proposer at
   mean 0.847), and ran three budget-matched arms: the feasible-quality margin was
   +0.008 [0.000, 0.025] vs validator-filtered best-of-3 and 0.000 vs unfiltered; the
   replication put both at +0.05 [0, 0.15]. Every CI touches or straddles zero. What
   replicated exactly: infeasibility handling 3/3 vs 1/3 for both baselines, zero
   constraint laundering. Compile-by-construction (100%) is unamended and met.
   Final: one real scanned room to
   parametric IFC with headline quantities within 5% of a manually modeled reference, plus one
   world-model scene imported with a bill of quantities.

### M6. Geometry at silicon speed

1. **Objective:** exact path fast enough to sit inside per-token, per-gradient-step, per-frame
   loops: wide-arithmetic wasm in CI, threaded CSG on by default, exact predicates on WebGPU.
2. **Today:** exact CSG is CPU-only everywhere; nobody has shipped exact predicates on GPU;
   the repo's own measurements (1.71x wide-arith e2e, 2.9-4.2x threaded CSG-step) are sitting
   de-risked but unshipped.
3. **New:** the predicate cascade is already factored to make sign-decisions auditable
   (predicate-sign manifest), which is exactly what makes a GPU port verifiable: the filter
   cascade, not float luck, decides every sign, and the manifest proves parity.
4. **Who cares:** every other moonshot; the computational geometry community (a WGSL exact
   predicate library is a paper and a first); every wasm-heavy geometry product watching
   wide-arithmetic.
5. **Risks:** V8 implementing the opcodes is outside our control, and there is no flag
   to wait for (accept; the CI lane watches for it and turns red when it lands); threading must not break byte-determinism (mitigate: parallelism
   stays at element granularity where outputs are independent, deterministic reduction order,
   determinism manifest gates the PR); GPU predicate speedup eaten by divergence and
   escalation traffic (see kill criteria).
6. **Cost:** M6a 0.5 cycle (CI lane), M6b 1-2 cycles, M6c 2 spike cycles + 2 more if passed;
   human: none until paper authorship.
7. **Time:** M6a/M6b Phase 0-1; M6c spike Phase 1, library Phase 2-3.
8. **Exams.** M6a: weekly CI lane builds with +wide-arithmetic and reproduces the determinism
   manifests byte-identically, >= 1.5x e2e CSG confirmed. M6b: threaded path on by default in
   the browser, determinism manifest unchanged, >= 1.5x wall-clock on the CSG-heavy corpus
   half. M6c midterm (spike gate): batched orientation3d/incircle on WebGPU with sign-exact
   agreement vs CPU on 10^8 random + adversarial near-degenerate inputs, >= 10x throughput.
   Final: one kernel stage (candidate: pairwise triangle intersection classification) running
   GPU-side with end-to-end manifest parity and >= 5x stage speedup on real models.
   **RESOLVED 2026-07-25, met literally and lost economically (amendment 2).** On real
   workloads extracted from the production CSG pipeline (194/194 fidelity-gated jobs
   byte-identical), sign-for-sign manifest parity is EXACT and the speedup clause is met
   against the equivalent exact CPU evaluation: 5.8x to 25.1x with model-wide batching.
   Against the path that actually ships (native Shewchuk adaptive filtering) the GPU
   LOSES on every model, 0.05x to 0.20x realized and ~0.2x asymptotic (~80 ns/tuple GPU
   vs ~15 ns native; the degenerate-only subset cannot win either at ~65 ns, since
   identifying it requires running the filter anyway). Per-op dispatch, the batch shape
   the current kernel structure produces, sinks to 0.8x-1.1x on three of five models.
   Remaining M6c exam is retargeted to publication (B6.3), not a speedup. Consequence:

<!-- numeral-ok: 0.20x, 194 :: 0.20x is the endpoint of a RANGE measured against the
     production adaptive-Shewchuk path; report.b25.throughput.json emits speedups against
     the exact BigInt CPU baseline (4.4x / 19.5x / 102x) and holds no production-path
     comparison, so the ratio is computed outside the artifact. 194 is the size of the
     fidelity-gated job corpus extracted from the production CSG benchmark, which lives
     under benchmark/, not under scripts/moonshot. -->
   M3's per-step projection budget re-plans around CPU threading only, which puts M6b on
   the critical path. See scripts/moonshot/b34-kernel-stage/REPORT.md.

## 3. Phased roadmap with gates

Cadence: Shape Up 6-week cycles. Phases are 2 cycles (~3 months) except Phase 0 (1 cycle).
Each phase ends at a betting table that doubles as the gate review. Gate criteria are the
exams above; they are pre-committed and only the betting table can amend them, in writing, in
this file.

### Phase 0, one cycle (target: through early Sep 2026; ACTUAL: executed 2026-07-24). "Foundations and first proof."

Bets:
- **B0.1 Hash spec + certificate v0 (M1).** Unify mesh manifests, blob hashes, and diff
  fingerprints into one canonical node-hash spec; certificate with the three v0 claim types;
  browser verifier. Flagship demo: two tabs, edit, verify, catch a tampered claim.
- **B0.2 Wide-arithmetic CI lane (M6a).** Nightly/weekly build with the flag, manifest parity,
  perf tracked. Turns an external dependency into a tripwire.
- **B0.3 Threaded CSG wiring spike (M6b).** Behind a query flag, determinism-gated.
- **B0.4 Gym API skeleton (M2).** reset/step/reward over the headless CLI wrapping existing
  checks on existing fixtures; no generator yet. Proves the env contract early and cheaply.

Gate G0: B0.1 demo passes the M1 midterm timing on a real 100 MB fixture; B0.3 shows >= 1.5x
without manifest changes; B0.4 runs an agent loop end to end. Fail on B0.1 = the program's
core premise (cheap subtree replay) is wrong; stop and rethink before spending more.

### Phase 1, two cycles (target: Sep-Dec 2026; ACTUAL: executed and gated 2026-07-24, M6c verdict 2026-07-25). "The root and the factory."

Bets:
- **B1.1 Merkle DAG + memoized recompute (M1).** Dependency-tracked recomputation through the
  void-router graph; cache-hit telemetry on real edit traces.
- **B1.2 Procedural generator v1 (M2).** Parameterized building families over packages/create
  coverage; labeling pipeline (checks + drawings + quantities); 100k-model corpus run.
- **B1.3 GPU predicate spike (M6c).** The sign-exactness battery. This is a true spike: two
  cycles, then the gate decides.
- **B1.4 Region footprints (M1 to M4 handoff).** Affected-region hashes computed per op,
  measured for tightness on collab traces.

Gate G1: M1 midterm + M2 midterm + M6c spike gate, each as specified in section 2. M6c fail =
kill M6c (ledger entry), M3's step-time budget re-planned around CPU threading only.

### Phase 2, two cycles (target: Dec 2026-Mar 2027; ACTUAL: executed 2026-07-24/25). "Theorems and training."

Bets:
- **B2.1 Merge soundness contract (M4):** commutation certificates + conflict predicates +
  the 1,000-schedule property battery.
- **B2.2 Benchmark launch (M2):** held-out splits, client-side verifier, leaderboard;
  human track: recruit one external lab.
- **B2.3 Constrained decoding harness (M5):** grammar/validator-coupled decoding over the
  create-op vocabulary, trained/evaluated on B1.2's corpus.
- **B2.4 Differentiability spike (M3):** the finite-difference-vs-adjoint battery on the
  parametric path, flagship objective = embodied carbon.
- **B2.5 GPU predicate library (M6c, only if G1 passed).**

Gate G2: M4 midterm, M5 midterm, M3 spike gate. M3 fail = downgrade M3 to derivative-free
optimizer over the same objectives (still demo-able, no longer a moonshot claim), ledger entry.

### Phase 3, two cycles (target: Mar-Jun 2027; ACTUAL: executed 2026-07-24/25). "The compounding demo."

**STATUS 2026-07-26 (amendment 3): three of five bets delivered.** B3.3, B3.4 and B3.5
landed. **B3.1 (encrypted provable multiplayer) and B3.2 (scan-to-parametric) were never
built** and are carried into Phase 5 as B5.4 and B5.5 rather than silently absorbed.
Both skipped bets are the two that required contact with something outside the
parametric sandbox; see the "building on the safe side of the risk" pre-mortem entry in
moonshots-finishing-plan.md section 8.

Bets:
- **B3.1 Encrypted provable multiplayer (M4 final).**
- **B3.2 Scan-to-parametric (M5 final), plus world-model import demo.**
- **B3.3 Differentiable flagship demo (M3 final, budget depends on M6 outcomes).**
- **B3.4 Kernel stage on GPU with manifest parity (M6c final).**
- **B3.5 The integrated jaw-drop:** one scripted 10-minute demo chaining them: scan a room,
  ground it to parametric IFC (M5), three parties co-edit encrypted with certified merges
  (M4), descend carbon under compliance (M3), every step certified (M1), interactive because
  of M6, all in browser tabs. This is the artifact for stages and data rooms.

Gate G3 = the final exams. Publications track (human calendar): M6c predicate paper and the
M4 convergence-theorem writeup are the two publishable results; target venues chosen by Louis.

## 4. What this costs

Roughly 24-30 agent-cycles across ~11 months, heavily parallelizable within phases (typical
phase runs 4-5 concurrent bets). The scarce resources are not agent-cycles; they are:
(a) Louis's gate-review and taste time, ~2 days per gate; (b) the human calendar items in
section 6; (c) GPU/model budget for M2 training validation and M5 (the only meaningful cash
line item; everything else is compute-light). No hiring is assumed; one external collaborating
lab (M2) and one paper co-author (M6c) are the only external dependencies, both optional for
the technology and valuable for the jaw-drop.

## 5. Kill criteria and pre-mortem

Pre-committed kill conditions (ledger entry mandatory, resurrection requires new evidence):

- **M1:** if subtree replay on real models cannot get under 5 s at the 95th percentile after
  Phase 1 optimization, certificates cannot be interactive and the trust story collapses to
  batch audit; descope M4/M3 certificate streaming accordingly.
- **M2:** if a model post-trained on the synthetic corpus shows no improvement on real-IFC
  held-out tasks by G2, the realism gap is structural; pivot corpus to augmented-real and
  re-gate once.
- **M3:** spike gate is binary. No adjoint battery pass, no differentiable moonshot.
  **AMENDED 2026-07-29 (betting table, amendment 6 of moonshots-finishing-plan.md
  section 9). PROVISIONAL: this amendment carries gate-holder sign-off when
  docs PR #1897 is merged by the repo-owner account, which is what sign-off
  means in this program - see that file's section 9.1. Until then it is the
  proposed record, and the claim is checkable with `gh pr view 1897`.** The Phase 4 spike (B4.4) was run against the **extrusion mesher**,
  not the CSG/void path this criterion was written about (see the kill risk at
  section 2, M3, risk 6). Its own oracle then showed the extrusion volume is a
  smooth closed form, so that exam could not have failed. **B4.4's PASS therefore
  neither passes nor fails this criterion.** M3's status is
  **UNADJUDICATED**, and it stays that way until a CSG-adjoint bet is run.
  **That bet is NOT scheduled.** Phase 5 contains B5.1 to B5.5 and nothing else;
  the CSG-adjoint work has no number, no exam, no kill clause, no statement of
  which of B5.1 to B5.5 it would displace against the five-bet cap, and no
  cycle-budget line. Entering a bet is a betting-table act, not a sentence in an
  amendment, so nothing here schedules it and no reader should infer that it is
  queued, next, or first in Phase 5. What exists is an input to that decision:
  `scripts/moonshot/b44-kernel-adjoint/DESIGN.md` section 6.1 scopes the
  obstruction at two cycles and names it (the exact-predicate tier is a
  fixed-width integer type with no derivative slot).
  Note also what the PROVISIONAL marker above does and does not mean: merging
  #1897 makes this amendment *signed by the gate holder*, i.e. part of the
  record. It is not approval of a CSG-adjoint bet, and it is certainly not
  completion of one.
- **M4:** if footprint tightening cannot get false-conflict rate below 20% on real traces,
  provable merging is technically true but practically annoying; keep the theorem, drop the
  auto-merge product claim.
- **M5:** if constrained decoding cannot beat the unconstrained baseline by G2, the grounding
  thesis is wrong at current model quality; park with a dated re-entry condition (next
  base-model generation).
- **M6c:** spike gate is binary at >= 10x predicate throughput with sign-exactness. Below
  that, publish the negative result; it is still a contribution.

Pre-mortem, the three most likely ways the whole program dies, and their antidotes:
1. **Diffusion of effort.** Six moonshots invite six half-demos. Antidote: the phase gates are
   few and brutal, and Phase 3 exists to force convergence into one artifact (B3.5).
2. **The human calendar slips.** Agents finish, gates stack, and review becomes the
   bottleneck (this happened in the 14-agent planning workflow). Antidote: gates are betting
   tables Louis already holds; no separate ceremony, max 5 bets per phase.
3. **Maintenance starves the program.** The main repo's issue/perf cadence (300+ commits per
   month) absorbs everything. Antidote: moonshot bets are explicit betting-table line items
   with their own worktrees; if a phase gets zero bets twice in a row, that is a deliberate
   written decision to pause the program, not a silent fade.

## 6. Agent-buildable vs human-only ledger

Parallel track (agents can build without permission-blocking):
hash spec drafts, verifiers, DAG plumbing, generator + labeler, gym API, property batteries,
WGSL predicate ports, threading wiring, decoding harness, benchmarks, demos, docs.

Serial human calendar (the real schedule):
- Certificate/hash **spec approval** and any ABI freeze (same rule as CHECK_OUTPUT_SCHEMA_VERSION).
- **Trust-root and signing-key custody** (M1, M4 encrypted demo).
- **Corpus and benchmark licensing** decisions, and benchmark governance.
- **External lab recruitment** (M2) and any co-authorship.
- **Paper submissions** (M6c, M4).
- **Model/GPU budget** approvals (M2 validation, M5).
- **V8/browser advocacy** for wide-arithmetic (issue comments, origin trials): low effort,
  nonzero leverage, only Louis can sign it.
- **Every merge to main.** Nothing in this program lands without explicit per-PR permission,
  as always.

## 7. First moves (this worktree, on approval)

1. Bet B0.1: draft the canonical node-hash spec as `docs/vision/spec/node-hash-v0.md`,
   inventorying and reconciling the three existing hash systems (mesh determinism manifests,
   collab blob hashes, diff fingerprints).
2. Bet B0.2: add the wide-arithmetic CI lane next to determinism.yml.
3. Bet B0.4: prototype `ifc-lite gym` as a thin CLI subcommand over existing checks.
4. Schedule the Phase 0 betting table.

---

## 8. Negative-results ledger (backfilled 2026-07-26, amendment 4)

Section 1 mandates a ledger entry for every killed or downgraded item so they are
not accidentally re-spiked in a year. Until now it held effectively nothing. Backfill,
newest first. Each entry states what was believed, what was measured, and what the
belief costs to revive.

**N1. M6c: exact predicates on GPU lose to adaptive filtering at the classification
stage (2026-07-25).** Believed: a sign-exact GPU predicate library would accelerate the
kernel's hot classification stage. Measured: parity exact and >= 5x versus exact CPU
evaluation, but 0.05x-0.20x versus the production adaptive-Shewchuk path, asymptotically
included. The adaptive filter resolves almost every predicate in floating point and never
pays the exact-arithmetic cost the GPU is optimizing. Reviving requires either a stage
whose realized arithmetic is genuinely exact-dominated (the escalated LPI/TPI tiers are
the named candidate, ~5000x per call) or a consumer with no adaptive filter. Do not
re-spike the classification stage.

<!-- numeral-ok: 5000x :: order-of-magnitude cost of an escalated LPI/TPI exact tier per
     call, from the kernel's own predicate profiling, not from a b25 report. -->

**N2. M2 benchmark v1.0 integrity is broken by construction (2026-07-25).** Believed:
forbidding access to the label fields was sufficient to protect the answer key. Measured:
`benchmark/attacks/clean-twin-diff.mjs` regenerates each seed's clean twin
(`corruptRate: 0`, corruption lives on an independent RNG stream), diffs the bytes, and
scores an exact 1.000 aggregate through the real scorer, above the kernel oracle (0.931)
and the text heuristic (0.993), reading only `model.content`. Adding geometric or organic
defect families does NOT fix this: any defect on an independent stream is isolated by the
same diff. Reviving a public launch requires denying the adversary the clean twin
(a secret per-split salt mixed into every RNG stream, or a real-model substrate that has
no procedural twin), not a longer defect list.
*Corrected with spec v1.1: this list originally read "hosted bytes, secret per-split
salt, or a real-model substrate". Hosted bytes alone deny nothing - splits are seed
arithmetic over a public universe and `generateModel` takes no secret, so the adversary
regenerates both twins locally and never requests the served bytes. Hosting is the
delivery channel a salt needs, not an integrity mechanism; see the benchmark spec's
integrity-model section.* The attack stays committed as a regression.

<!-- numeral-ok: 0.931, 0.993 :: aggregate scores of the kernel oracle and the text
     heuristic through the real benchmark scorer. Emitted by the benchmark harness under
     benchmark/, not by any scripts/moonshot artifact. -->

**N3. M5 feasible-brief quality margin is null (2026-07-25, replicated).** Believed:
per-op kernel feedback would produce better programs than the same model generating
freely. Measured across two tiers and one fresh-sample replication: no detectable
feasible-quality margin against a budget-matched informed baseline (+0.008 [0.000, 0.025]
and +0.05 [0, 0.15]; both CIs touch zero). The value that does replicate is at the
infeasibility boundary (3/3 vs 1/3) and in recovery from rules held out of the prompt.
Reviving the margin claim requires a weaker proposer or briefs whose constraint
interactions defeat three informed samples; at Haiku strength on these tiers it is not
there. See amendment 1.

**N4. Threaded WASM as a whole-pipeline lever, re-refuted (2026-07-23, pre-dates the
moonshot program but bears on M6b).** Measured 0.87x on the full pipeline (atomics tax).
M6b's 2.9x-4.2x is a CSG-stage figure and must not be restated as an end-to-end one.

**Calendar note (amendment 5).** Phases 0 through 3 were executed 2026-07-24/25, roughly
eight months ahead of the targets recorded above, because the agent-build track ran far
faster than the plan assumed while the human-calendar items (spec freeze, integrity
decision, external recruitment) did not move. The targets are left in place as written
rather than rewritten, since the gap between them and the actuals is itself the finding:
agent-cycles were never the scarce resource. Phase 4 to 6 targets live in
moonshots-finishing-plan.md.
