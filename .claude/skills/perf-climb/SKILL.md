---
name: perf-climb
description: Long-running, measurement-first performance optimization loop for ifc-lite. Use when a thread is chartered to drive one load/interaction journey or benchmark down (parse, geometry, cold/warm open, first pixel, main-thread blocking, frame time) and should keep iterating — measure, hypothesize, prototype, prove end-to-end, ship, ratchet — until the charter's stop condition, not just until the first win.
---

# perf-climb: hill-climb one ifc-lite journey

You are running a long, mostly autonomous optimization thread. The human owns
taste and sequencing; you own measurement, hypotheses, prototypes, proof and
bookkeeping. Be ambitious inside the charter: hitting the target is not the
stopping point, the charter's stop condition is. Be ruthless about proof:
an unproven win is not a win.

Read first, every thread, in this order:
1. `AGENTS.md` → **Performance** and **Geometry & WASM** sections (binding rules).
2. `scripts/perf/README.md` → TL;DR, **Lever ledger**: *Shipped wins*,
   *Dead ends*, *Cold-start / CSG levers*, *Reading the FIELD telemetry*,
   *Standing constraints*. Do not re-spike a dead end without a genuinely new
   mechanism, and say which new mechanism when you do.
3. The charter issue for this thread.

## 0. The charter (refuse to start without one)

A thread climbs exactly one hill. The charter issue (labelled `ready`, or
`unqueued` by the maintainer) must name:
- **Journey**: where the clock starts and stops, in user terms (e.g. "file drop
  → first geometry pixel", "click → properties panel populated").
- **Metric(s)**: the end-to-end number that is the verdict, plus any
  deterministic proxy you may climb in the lab.
- **Fixtures**: default `tests/models/ara3d/AC20-FZK-Haus.ifc`; CSG/void/mesher
  work adds `ISSUE_129_...` and, when feasible, Holter/ISSUE_053.
- **Stop condition**: a target *and* a diminishing-returns rule (e.g. "three
  consecutive candidates under 2% end-to-end").
- **Budget**: wall-clock hours or number of PRs, after which you report back.

If any of these is missing, propose them in one message and wait.

## 1. Measure before touching code

- Establish the baseline on the base commit with the repo's own tools:
  `scripts/perf/probe.sh <fixture> --iters 5 --json` (native, per phase),
  `scripts/perf/browser-cold-ab.sh` (browser cold load, interleaved
  base-vs-branch), `scripts/perf/flame.sh` (which function).
- If the journey has no instrument that starts at the user action and ends at
  the rendered result, **building that instrument is the first PR**. Measuring
  makes a problem tractable; it is the highest-leverage work in the thread.
- A deterministic proxy (instruction count, call count, React commits, long
  animation frames, worker messages/bytes, GPU uploads) may be climbed in the
  lab only after you have shown on at least two past changes from the ledger
  that it moves with the end-to-end number. If it does not track, delete it —
  never climb a hill that does not lead to users.

### Measurement hygiene (non-negotiable)
- **Serialize timing.** Other threads may share this machine. Wrap every timed
  run in the shared lock so parallel threads never contaminate each other:
  `flock /tmp/ifclite-perf.lock scripts/perf/probe.sh ...`.
  Exploration, builds and unit tests do not need the lock.
- Base-vs-branch, interleaved, never vs `tests/benchmark/baseline.json`.
- Confirm `packages/wasm/pkg/ifc-lite_bg.wasm` is newer than your `rust/`
  edits before trusting any WASM number.
- Every result states a **byte-identity verdict**: mesh/vertex/triangle counts
  unchanged, or an ordered geometry fingerprint if output may legitimately
  differ (then re-pin the determinism manifests and parity references per
  AGENTS.md).

## 2. The loop

Repeat until the stop condition or budget:

1. **Locate.** Profile the slowest stretch of the journey. Name it concretely
   (function, phase, publication, frame) with numbers.
2. **Hypothesize.** Write 3–5 candidate levers, each with an estimated saving
   in ms on the charter fixture and an estimated diff size. Check each against
   the ledger. Include at least one bold option ("what would we do if this
   phase had to go to zero?").
3. **Triage by value per complexity.** Drop candidates whose estimated saving
   does not justify their maintenance cost. Rule of thumb: a new build plugin,
   cache layer, or second code path needs a user-visible saving, not 2 ms.
   Never fork `produce_element_meshes`, colour resolution, or the load path
   (`useIfcLoader.loadFile`).
4. **Prototype** in a git worktree, one lever per branch. Write or extend the
   behaviour test for the code you are about to change *before* optimizing it,
   so the speedup is checked against pinned behaviour, not against itself.
5. **Prove** end-to-end (worker pool / browser), interleaved, with the
   byte-identity verdict. A kernel-only microbench win is not evidence.
6. **Ship.** One lever per PR, sized for review (stack above ~1,500 lines).
   The PR carries the perf verdict table (base vs branch, parse/geometry/total
   deltas, iterations, machine) and closes or references the charter issue.
   Anything user-visible (ordering of streamed geometry, panel timing,
   placeholders, fades) ships behind a short-lived flag or kill switch.
7. **Lock it in.** Add or tighten a guard so the win cannot silently decay
   (a test, a deterministic-count ceiling that may only go down, or a
   benchmark threshold). A win without a guard is a loan.
8. **Record** the verdict and the lesson in the `scripts/perf/README.md`
   ledger in the same PR — wins *and* refutations, so nobody re-walks them.
   Numbers for the docs table live only in the generated region of
   `docs/guide/performance.md`.
9. **Next.** Re-profile; the bottleneck has moved. Go to 1.

Opportunities you find outside the charter's journey are not scope creep to
absorb: append them to the charter issue as a proposed new charter (journey,
metric, estimated ms) and keep climbing your own hill.

Every flag you add is classified in its PR as a **kill switch** (stays, guards
a risky path) or a **ramp** (temporary; names the condition for removing it).
Retire ramps as soon as that condition holds; a thread's summary lists the
ramps it still owes.

## 3. Human checkpoints (stop and ask)

- Any user-perceptible change: post before/after screenshots or recordings and
  the trade-off (e.g. "first pixel 180 ms earlier, but storeys pop in out of
  order") and wait for a ruling.
- A lever that needs a new dependency, a new package, a public API change, or
  a wasm `.d.ts` change.
- Two threads touching the same hot file: say so and propose a sequencing.
- Budget exhausted or stop condition met: post the summary (below) and stop.

## 4. Never

- Weaken, skip or delete a test, parity gate, determinism manifest or
  benchmark to get green.
- Trade correctness for speed: stale caches without validation, dropped
  georeferencing, skipped elements, lower CSG fidelity.
- Claim a speedup from a local `pnpm benchmark:check` against the committed
  baseline, from a single run, or from a different browser/launch mode.
- Push Rust without `cargo clippy --workspace --all-targets -- -D warnings`
  and `cargo test --workspace`; push TS without root `pnpm typecheck` and
  `pnpm test`.

## 5. Keep state on disk so the thread survives compaction

Maintain `.perf-climb/<issue-number>.md` (gitignored scratch) with: charter
summary, current baseline numbers, the candidate list with status
(`todo / prototyping / proven / shipped / refuted`), open PRs, and the next
step. Re-read it after any context compaction or restart before acting.

## 6. Progress reports

Report only when a PR goes up, a candidate is refuted, a checkpoint needs a
human, or the thread ends. Format:

```
Journey: <name>    Fixture: <file>
Baseline → now:    <metric> 1234 ms → 987 ms (−20%), byte-identical
Shipped:           #NNNN <lever> (−150 ms), #NNNN <lever> (−97 ms)
Refuted:           <lever> — <why>, ledger updated
Next:              <hypothesis> (est. −60 ms, ~200 lines)
Needs you:         <decision, or "nothing">
```
