# Moonshots: where the technology can go

Written 2026-07-24, on a worktree off main. This is a technology brainstorm, not a product plan.
It deliberately ignores go-to-market, pricing, and buyer language. The question it answers is:
given what this codebase actually is after six months, what technical bets would drop jaws,
including the jaws of people who fund frontier infrastructure?

## 1. What six months actually built

<!-- numeral-ok: 1,376 :: repository commit count on the day this section was
     written, from `git rev-list --count`. A fact about the repo, not a bet
     measurement; no artifact emits it and none should. -->
The repo is 1,376 commits old (first commit 2026-01-12). The commit rate tripled from ~120/month
in Jan-Apr to 368 in June. Underneath the viewer, the following assets now exist and are verified
in CI, and together they form something no other codebase in AEC has:

1. **A deterministic, exact-arithmetic CSG kernel that produces byte-identical output on
   x86_64, aarch64, and wasm32.** Shewchuk adaptive predicates escalating through fixed-width
   big integers (I256..I2048) to exact rationals; symbolic implicit points that are never
   materialized to floats; predicate-sign manifests and per-mesh FNV-1a64 byte hashes pinned
   in CI, re-verified weekly on arm64. It took four kernel generations (csgrs, local BSP,
   Manifold, Manifold-on-wasm) to get here, then 100+ correctness PRs closing parity against
   IfcOpenShell as a live differential oracle. Determinism was fought for, not assumed.
2. **A columnar data plane.** EntityTable as raw TypedArrays, parquet extraction in Rust with
   hash-pinned wire contracts shared by server and client, DuckDB query integration. Buildings
   are already dataframes here.
3. **A WebGPU renderer, not a three.js app.** Reverse-Z, chunked residency with GPU budget and
   LRU eviction, instancing, quantized vertices. Bonsai-class model scale in a browser tab.
4. **A CRDT collaboration layer that already treats geometry as content-addressed data.**
   Y.Doc runtime, a content-addressed geometry blob store, a CRDT array of CSG ops, three-way
   merge with conflict records, layer publish/review with provenance, E2E encryption where the
   server only routes ciphertext, and AI agents as first-class named peers with per-principal
   rate limits and audit logs.
5. **An IFC5/IFCX composition engine.** ECS-style path-keyed nodes, layer stacks with
   later-layer-wins semantics, tombstones, provenance, round-trip tests. This is a working
   implementation of the standard the industry is still writing.
6. **An agent-native surface at every level.** MCP server with ~20 tool families including
   driving a headless viewer; a QuickJS-in-wasm sandbox with a capability grammar
   (network.fetch:host, mutate:Pset scopes) where agents author their own extensions; a
   transport-agnostic SDK whose whole API dumps as JSON for agent discovery; a CLI that
   evaluates arbitrary SDK expressions headlessly.
7. **A verification culture unusual for the domain.** Fuzzing, property tests, parity tests
   between TS and Rust, API-surface snapshots, module-size ratchets, a negative-results ledger
   (threaded wasm honestly recorded at 0.87x for the full pipeline, then re-measured and
   revised when the workload changed shape).
8. **Two de-risked engine levers already measured and documented:** wasm wide-arithmetic
   (1.9-3.1x on predicates, 1.71x end-to-end CSG, blocked only on browser flags) and threaded
   CSG via wasm-bindgen-rayon (2.9-4.2x on the CSG step, architecture validated).

<!-- numeral-src: 1.9, 1.71x, 3.1x :: none - wasm wide-arithmetic speedups: BOTH
     endpoints of the predicate range (1.9x to 3.1x) plus the 1.71x end-to-end
     CSG figure. Measured by docs/architecture/wasm-wide-arithmetic.md and its
     benchmark; cited here, produced elsewhere, and no scripts/moonshot artifact
     emits any of them. Bound to `none` rather than left to the union index so
     that a coincidental hit on a bare 1.9 or 2.9 cannot read as provenance. -->
<!-- numeral-src: 2.9, 4.2x :: none - BOTH endpoints of M6b's threaded-CSG range
     (2.9x to 4.2x), a CSG-STAGE figure and not an end-to-end one; see the
     negative-results ledger entry N4 in moonshots-execution-plan.md. Measured
     before this program committed any artifact for it; nothing in
     scripts/moonshot/ emits it. -->

Compressed to one sentence: **this is the only geometry system in the built-world domain that
is simultaneously exact, deterministic to the byte, content-addressable, browser-native,
multiplayer, and agent-native.**

## 2. What the 2026 frontier looks like

- **World models are the year's mega-trend.** Over $2B raised in Q1 2026 alone: World Labs'
  Marble ($1B round, with Autodesk and NVIDIA investing), Genie 3 at 24fps interactive,
  LeCun's AMI Labs ($1.03B seed). All of it neural, probabilistic, photoreal. None of it
  semantic, parametric, or auditable.
- **Autodesk announced Neural CAD**, foundation models for Forma and Fusion, commercial in
  2026: cloud-hosted, proprietary, trained on customer design data, generating editable CAD.
- **RLVR (reinforcement learning with verifiable rewards) is the dominant post-training
  paradigm**, and the literature states plainly that the supply of verifiable training
  environments is the rate-limiting factor for agent capability. Reasoning Gym, NeMo Gym,
  CUA-Gym exist for math, code, and computer use. Nothing exists for the built world.
- **The agentic-BIM press names the gap precisely.** AEC Magazine: current tools lack a
  governance layer for delegation; what is needed is "verifiable task completion: outputs must
  be provable" and "mathematical proofs demonstrating constraint compliance"; MCP is "an
  interface-layer technology asked to carry a governance-layer load."
- **Text-to-CAD research converged on program synthesis grounded by a kernel.** Zero-to-CAD
  synthesizes million-scale CAD programs with no real data, using the kernel as oracle; GIFT
  bootstraps image-to-CAD via geometric feedback; Embodied CAD grounds LLM agents in a solver.
- **Scan-to-BIM via semantic Gaussian splatting is maturing fast**, and differentiable GPU
  physics (NVIDIA Warp, JAX-class CFD) is production-adjacent.
- **IFC5 and OpenUSD are converging** under a buildingSMART-AOUSD liaison.

The pattern across all of it: the industry is pouring billions into machines that **imagine**
buildings, and almost nothing into the layer that can say **provably yes or no** to what they
imagine. Imagination is becoming a commodity. Ground truth at machine speed is becoming the
scarce asset.

## 3. The thesis

**Neural systems propose; the kernel disposes.**

Every frontier direction above eventually needs a substrate with exactly the properties this
codebase spent six months acquiring: exactness (so answers are true), determinism (so answers
are reproducible and therefore checkable by strangers), content-addressability (so state has
identity and history), browser-nativeness (so verification runs anywhere, including inside the
loop of a web agent), and agent-nativeness (so machines are first-class users). The moonshot
is not to join the imagination race. It is to become the ground truth layer the imagination
race is forced to stand on.

Six concrete moonshots follow. Each is technology, each is buildable from assets that already
exist in this repo, and each is individually jaw-dropping. Together they compound.

## 4. The moonshots

### M1. Proof-carrying buildings

Content-addressed semantic geometry, all the way down. Because the kernel is byte-deterministic,
every element's geometry already has a canonical hash; the collab layer already stores geometry
blobs content-addressed; the diff engine already uses RTC-invariant hashes. Push this to its
logical end: the entire building becomes a Merkle DAG. Every node (mesh, property set,
relationship, layer, storey) is identified by the hash of its content plus the hashes of its
inputs.

What falls out is not incremental:

- **Proof-carrying changes.** A change to the model ships with a certificate: the set of input
  hashes it read, the set of output hashes it produced, and machine-checkable claims
  ("no element outside this subtree changed", "clearance to structure >= 50mm everywhere",
  "net volume delta = 0.34 m3"). Any third party replays the deterministic pipeline on the
  affected subtree and either reproduces the hashes or catches the lie. This is the
  "mathematical proof of constraint compliance" the agentic-BIM world is asking for, delivered
  as cryptography plus determinism instead of policy documents. It is the governance layer for
  agent autonomy: an agent's permission scope becomes a set of subtree hashes it may touch,
  enforced by verification rather than trust.
- **A build system for the physical world.** Deterministic function + hashed inputs = perfect
  memoization. Change one wall and only the affected DAG subtree recomputes; everything else is
  a cache hit, forever, shareable across every machine on earth (the hash of a standard door's
  geometry is the same hash in Tokyo and Zurich). This is Bazel/Nix semantics applied to
  buildings, and nobody in AEC has it because nobody else has the determinism to make cache
  hits sound.
- **Global deduplication and provenance.** An industry-wide content-addressed store where
  identical components are stored once, and every element in every model carries a verifiable
  chain of custody back through every edit that produced it.

Hard problems worth respecting: certificate format design for geometric invariants; incremental
recomputation through the void-cutting dependency graph; hash stability across kernel versions
(the predicate-sign manifest becomes part of the trust root). First demo: two browser tabs, one
edits a wall, the other verifies the change certificate in milliseconds without re-downloading
the model, then a third party proves the agent that made the edit could not have moved anything
else. No one has ever shown that on stage.

### M2. The World Gym

The kernel as an RL environment for the built world. RLVR's bottleneck is verifiable
environments; this repo is one, accidentally. The pieces: parametric authoring
(packages/create) to procedurally generate unbounded building variations; the deterministic
pipeline to label every sample with perfect ground truth (quantities, clash sets, IDS verdicts,
storey graphs, 2D drawings via drawing-2d, energy adjacency); headless execution at
milliseconds per element, embarrassingly parallel, on anything from a laptop to a browser farm.

Three escalating plays:

- **The data factory.** Million-scale synthetic IFC corpora with paired modalities: 3D model,
  plan/section drawings (SVG/DXF), schedules, graphs, point-cloud simulations. This is
  Zero-to-CAD's recipe applied to buildings. It also sidesteps the incumbents' data problem:
  Autodesk trains on proprietary customer designs it can never publish; a synthetic corpus with
  perfect labels is open, infinite, and legally clean.
- **The gym.** Wrap the CLI/MCP surface as an environment API: agent emits IFC ops, kernel
  returns deterministic rewards (parses, watertight, clash-free, code-compliant, quantities
  within budget). GRPO-style post-training against it. Every check the platform ships doubles
  as a reward function.
- **The benchmark.** Publish the eval: a leaderboard where any lab's model designs under
  verifiable constraints and the kernel scores it, reproducibly, in the browser. Whoever owns
  the benchmark owns the conversation about machine competence in the built world.

The jaw-drop framing writes itself: in 2026, verifiable environments are the scarcest commodity
in AI, and this would be the only one for the $12T built-world domain.

### M3. Differentiable buildings

The columnar data plane means a building is already tensors; make it differentiable. Implement
adjoints through the parametric path: design parameters -> profiles -> solids -> derived
quantities and physics objectives (daylight hours, embodied carbon, egress distance, structural
proxy loads, clash penetration depth). Run gradient descent on the design in the browser, with
WebGPU compute doing the heavy objective evaluation and the exact kernel serving as the
validity projection: after each gradient step, project back onto the manifold of buildable,
non-self-intersecting, code-legal configurations, and emit an M1-style certificate that the
projected state is valid.

This marries the two halves that are separately hot (differentiable simulation; neural design)
with the piece both lack: a projection operator with exactness guarantees. Autodiff through
smooth objectives is easy; knowing your optimum is a *valid building* is not. The demo: type
"minimize embodied carbon, keep daylight compliance" and watch the building visibly relax into
a better shape in a browser tab, with a live certificate stream proving every intermediate
state legal. VCs have seen generative massing; they have never seen a building being
gradient-descended with proofs.

### M4. Convergence you can prove

Multiplayer geometry with a merge theorem. Today CRDTs converge on data; geometry merges
elsewhere are last-write-wins mush or manual. Here, CRDT convergence composes with kernel
determinism into a statement nobody else can make: **any two replicas that converge on the op
log converge on the byte-identical building.** The merge is not a heuristic; it is a theorem
of the system.

Concretely: define edit ops with declared read/write footprints (region hashes from M1);
conflicts become exact geometric predicates (two ops whose affected regions intersect),
computed by the kernel rather than guessed by timestamps; the three-way merge engine already in
packages/merge gets a soundness contract: an auto-merge is emitted only with a certificate that
the ops commute geometrically. And because the collab layer already does E2E encryption, this
extends to the genuinely wild version: **encrypted multiplayer, where the server never sees the
building yet clients can still verify each other's merges via hashes.** Design-for-hire on
models the host provably cannot read. Figma solved multiplayer for vectors with OT and trust in
the server; this is multiplayer for solids with proofs and no trust in the server.

### M5. The grounding compiler

The bridge to the world-model wave, pointed our way. Neural front-ends (Gaussian splat scans,
photos, sketches, text, Marble-style generated worlds) never emit geometry directly; they emit
**programs** over the deterministic kernel, decoded under constraint, with the kernel giving
per-op geometric feedback during generation (the GIFT/Embodied-CAD loop, but for buildings and
running client-side). Three input classes, one compiler:

- **Scan-to-parametric:** semantic splats projected onto parametric IFC ops, with the kernel as
  projector; the output is not a mesh soup but walls, slabs, and openings with quantities, and
  the delta against the design model is an M1 certificate ("as-built deviates from design by
  these hashes, here").
- **Text/sketch-to-building:** constrained decoding where invalid ops are unreachable, because
  the validator runs in the same wasm as the sampler.
- **World-model import:** Marble or Genie dreams a space; the compiler grounds it into a
  building with a bill of quantities, code-check verdicts, and 2D drawings.

The neural model is fully commoditized in this picture, swappable, anyone's. The compiler and
its verifier are the durable asset. Trained, incidentally, on M2's synthetic corpus, scored by
M2's gym.

### M6. Geometry at silicon speed

The hardcore systems moonshot underneath all of the above: make exact geometry so fast it can
sit inside every loop that currently cannot afford it (per-token decoding feedback in M5,
per-gradient-step projection in M3, per-frame verification in M4). Three stacked levers:

1. **Wasm wide-arithmetic:** already measured at 1.71x end-to-end; ships the moment browser
   engines flip the flag (V8 has it behind one today). Zero-risk, pure patience, and this repo
   would likely be the first real-world workload on it.
2. **Threaded CSG:** 2.9-4.2x already validated via wasm-bindgen-rayon on the CSG-heavy loop.
3. **Exact predicates on GPU:** the research-grade one. Multi-word integer arithmetic (I256+)
   and Shewchuk-style adaptive filters implemented in WGSL compute, batching millions of
   orientation/incircle tests per dispatch, with the rational tier staying on CPU as the rare
   escalation path. Nobody has shipped exact-arithmetic CSG on WebGPU. The determinism story
   survives because the filter cascade, not float luck, decides every sign. Published as a
   paper plus an open kernel, this alone buys the project a seat at the computational-geometry
   table that no BIM company has ever held.

Compounded, these plausibly buy 10-50x on the exact path, which converts every other moonshot
from "batch" to "interactive".

## 5. How they compound

M1 (hashes and certificates) is the root: it turns determinism into trust infrastructure.
M4 stands on M1 (footprints are region hashes). M2 stands on the kernel plus M1 (rewards are
certificates). M3 stands on M6 (projection must be fast) and emits M1 certificates. M5 consumes
M2's corpus and M6's speed and emits M1 certificates. The flywheel: every neural system that
builds on the substrate generates demand for verification, and every verification strengthens
the substrate's claim to being the ground truth layer.

The one-line version for the people with the checkbooks: **the world just spent two billion
dollars teaching machines to dream buildings; dreams do not get building permits. We built the
only thing that can grade the dreams, at machine speed, in a browser tab, with receipts.**

## Sources

- [Foundamental: State of AEC-Tech Q2 2026](https://www.foundamental.com/perspectives/the-state-of-aec-tech-in-q2-2026)
- [AEC Magazine: Agentic BIM's missing infrastructure](https://aecmag.com/ai/agentic-bims-missing-infrastructure/)
- [AEC Magazine: Autodesk unleashes neural CAD](https://aecmag.com/ai/autodesk-unleashes-neural-cad/)
- [Autodesk: upcoming 3D generative AI foundation models](https://adsknews.autodesk.com/en/news/upcoming-3d-generative-ai-foundation-models/)
- [World Labs](https://www.worldlabs.ai/) and [taxonomy of world models](https://www.worldlabs.ai/blog/taxonomy-of-world-models)
- [The Register: Google's Project Genie](https://www.theregister.com/2026/01/29/googles_project_genie_ai)
- [Reasoning Gym: RLVR environments (OpenReview)](https://openreview.net/forum?id=GqYSunGmp7)
- [CUA-Gym: scaling verifiable training environments](https://arxiv.org/pdf/2605.25624)
- [awesome-RLVR curated list](https://github.com/opendilab/awesome-RLVR)
- [Zero-to-CAD: agentic synthesis of CAD programs at million scale](https://arxiv.org/pdf/2604.24479)
- [GIFT: image-to-CAD via geometric feedback](https://arxiv.org/pdf/2603.27448)
- [Embodied CAD: solver-grounded LLM agents](https://arxiv.org/abs/2606.31252v1)
- [Diff-FlowFSI: differentiable GPU CFD](https://arxiv.org/pdf/2505.23940)
- [NVIDIA Warp for differentiable physics](https://developer.nvidia.com/blog/build-accelerated-differentiable-computational-physics-code-for-ai-with-nvidia-warp/)
- [S2GS: streaming semantic Gaussian splatting](https://arxiv.org/pdf/2603.14232)
- [buildingSMART IFC5 status](https://biblus.accasoftware.com/en/what-is-ifc-5/)
- [Geometry-aware version control for CAD (Novedge)](https://novedge.com/blogs/design-news/geometry-aware-version-control-for-cad-graph-based-workflows-semantic-diffs-lfs-locks-and-deterministic-ci)
