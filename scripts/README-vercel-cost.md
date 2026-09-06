<!--
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# CI/CD cost playbook (Vercel · Depot · GitHub Actions)

`ifc-lite` is a **public** repo with very high activity — 1,233 merges to
`main` in the 30 days to 2026-09-05, measured in §3a. That combination makes
CI/CD spend the dominant infra cost. This doc records why the spend happens
and the levers that control it.

Snapshot that triggered this work (June 2026). **Superseded for Vercel by §3**,
which is measured rather than estimated; kept for the Depot/Actions picture:

| Provider | ~Monthly | Why |
|---|---|---|
| Depot (GitHub Actions runners + cache) | ~$147 | Heavy CI jobs run on **paid** Depot runners; cache grew to 173 GB |
| GitHub Actions | **$0** | Public repo → standard runners are free + unlimited |
| Vercel (builds) | ~$165 | 3 repo-linked projects rebuilt on **every** commit; 1 was on the 30-core Turbo machine. Re-measured at $269.04 in §3, and fixed in §3a-fix |

---

## 1. The runner economics (read this first)

- **Public repos get free, *unlimited* standard `ubuntu-latest` runners.** GitHub
  only bills public repos for **larger** runners (4/8/16-core) — and those are
  *more expensive than Depot* (GH 8-core $0.022/min vs Depot $0.016/min). So you
  cannot "save" by moving big jobs to GitHub larger runners; the only free option
  is the standard 2-core `ubuntu-latest`.
- **Depot bills normalized minutes = `wall-minutes × (vCPU / 2)`.** A
  `depot-ubuntu-24.04` (2 vCPU) is 1×; `-4` is 2×; `-8` is 4×. So an 8-core job
  costs **4× per wall-minute** of the base. Right-sizing `-8 → -4` halves the
  per-minute cost for ~1.5× wall-clock.
- **Depot's value is the uncapped, fast cache** (no 10 GB LRU cap like GitHub's
  free Actions cache) + native arm64 runners. Keep Rust-compile jobs there so
  the cargo target dir doesn't thrash; push everything cheap to free runners.

### What runs where now (after this change)

| Job | Runner | Rationale |
|---|---|---|
| `changes`, `lint`, `typecheck`, `node-tests`, `test` gate | `ubuntu-latest` (free) | Not compile-bound; free + unlimited on a public repo |
| `test-templates` (6-way matrix) | `ubuntu-latest` (free) | Scaffolds + builds templates against published pkgs; no Rust/WASM compile, no cargo cache — never needed Depot |
| `desktop-override-audit` | `ubuntu-latest` (free) | Only `[ -f ]` file checks |
| `build` (WASM) | **`ubuntu-latest` (free) OR `depot-ubuntu-24.04-4`** | Frontend-only PRs fetch the prebuilt bundle and run free; Rust PRs compile from source on Depot. See §1a |
| `desktop-frontend-build` | `depot-ubuntu-24.04-4` | Compiles WASM from source |
| `rust-tests` | `depot-ubuntu-24.04-4` (was `-8`) | Kept on Depot for the cargo cache; right-sized for cost |
| ~~`manifold-tests`~~ | — | DELETED at M9 (Manifold C++ kernel removed; pure-Rust kernel runs in `rust-tests`) |

`release.yml`, `docs.yml`, `sdk-canary.yml` already use free `ubuntu-latest`.

### 1a. Prebuilt-WASM fast path in CI (the biggest compute lever)

The `build` job compiles `rust → wasm32` on **every** PR, but the WASM only
changes on the ~1/3 of PRs that touch Rust. On the other ~2/3 (viewer/frontend
work) the compile is wasted — and it's the single largest Depot compute line,
plus its `ci-build` Swatinem rust-cache is a top Depot storage entry.

The `changes` job now runs `scripts/ci-wasm-prebuilt-eligible.sh`, the CI twin
of the `scripts/vercel-install.sh` fast path. It emits `wasm_prebuilt=true` only
when the WASM source (`rust/** + Cargo.{toml,lock} + rust-toolchain.toml +
scripts/build-wasm.sh`) is **byte-identical to the `@ifc-lite/wasm@<version>`
release tag** that produced the published bundle. When true, `build`:
- runs on **free `ubuntu-latest`** instead of paid Depot (`runs-on` is a
  conditional expression on the output),
- **skips** the Rust toolchain, the wasm32 compile, and the `ci-build`
  rust-cache write to Depot,
- **fetches** the published bundle via `scripts/fetch-prebuilt-wasm.mjs` (the
  from-source `Build WASM` step then soft-skips: wasm-pack absent + runtime
  present → exit 0).

**Correctness:** any doubt (version unreadable, tag unreachable, Rust changed)
emits `false` → compile from source on Depot, exactly as before. Because the
guard is a byte-identical diff against the exact release tag, the fetched binary
is what a source build would produce — a stale bundle can never be tested. The
one new hard-fail path (prebuilt fetch fails on a runner with no Rust fallback)
is retried 3× so a transient npm blip doesn't block the PR.

### Depot — do this in the dashboard (one-time)
- **Cache → Retention: 7 days** — already set. Note this alone doesn't shrink a
  253 GB cache that's re-written faster than 7 days; the code-side levers (docker
  cache → GHCR in §2, the WASM fast path above) are what stop *feeding* it. The
  Cache Explorer shows the bulk is docker `buildkit-blob-*` (moved to GHCR by §2)
  + the `ci-build`/`ci-rust` rust-caches.

---

## 2. Docker image builds (`.github/workflows/docker.yml`)

`docker.yml` fires on every push to `main` that touches `rust/**` / `Cargo.*` /
`apps/server/**` (~1/3 of commits) and builds `linux/amd64,linux/arm64`. The
arm64 leg runs under **QEMU emulation** (slow) and **doubles the `type=gha`
cache** that drives Depot's per-GB bill.

Change: build **amd64 only on push-to-main** (`latest`/sha images), and
**multi-arch only on `release: published`** (distribution images). `mode=max` is
intentionally kept — it caches the cargo-chef "cooked deps" layer that makes
warm builds finish in minutes; `mode=min` would *raise* compute minutes.

**Cache backend moved off Depot (the bigger lever).** The build cache was
`cache-to: type=gha,mode=max`. On a Depot runner `type=gha` is intercepted by
Depot's cache backend and **billed per-GB** — and mode=max writes the whole
multi-GB cargo-chef layer set on every rust-touching main push, so this was the
single largest contributor to Depot's uncapped cache (it reached 173 GB). Now
it's `type=registry,ref=…/ifc-lite-server:buildcache` — the cache lives as a
`:buildcache` tag on the same GHCR package, which is **free + unlimited for
public packages**. Warm builds stay fast; the cache line drops to $0. Cost:
~1-3 min of extra network per build to push the cache to GHCR (vs Depot's local
cache). The docker job itself stays on Depot for compute; a further option is to
move it to a free `ubuntu-latest` runner (registry cache keeps warm builds
reasonable, but cold cargo-chef builds get slow — accept the timeout risk first).

Future option if arm64-on-main is ever wanted again: use Depot's **native arm64
runners** (`depot-ubuntu-24.04-arm-*`, AWS Graviton, no QEMU) via a build matrix
instead of emulation.

---

## 3. Vercel builds — the real picture

**Measured 2026-09-05, billing cycle 2026-08-06 → 09-06.** Vercel's bill is one
line item and everything else is noise:

| SKU | Cycle total |
|---|---|
| **Build CPU Minutes** | **$269.04** |
| Edge Middleware Invocations | $0.65 |
| Fluid Active CPU + Provisioned Memory | $1.00 |
| Fast Origin Transfer | $0.36 |
| Web Analytics / Functions / Blob / ISR | $1.00 combined |

So the only question that matters for Vercel spend is *how many builds run*.

### 3a. What drove it: one production build per commit, ×3 projects

`main` takes **1,233 squash merges per 30 days (~41/day)**, and each one fired a
production deploy on all three repo-linked projects. Preview deployments were
already free — each project's Ignored Build Step is
`if [ "$VERCEL_ENV" == "production" ]; then exit 1; else exit 0; fi`, which
cancelled 4,747 preview deployments over the same window before they built.
The deployment RECORD still exists — Vercel creates it, then marks it
`CANCELED` — so what is skipped, and never billed, is the build. Production
was the whole bill:

| Project | Root dir | Machine | Prod builds / 30d | Wall min | Median | Est. share |
|---|---|---|---|---|---|---|
| `ifc-lite` (viewer) | `./` | standard, fixed | 751 | 3,304 | 3.7 min | ~$125 |
| `ifc-lite-viewer-embed` | `apps/viewer-embed` | standard, fixed | 702 | 1,852 | 2.5 min | ~$140 |
| `ifc-lite-dev` (landing) | `apps/landing` | standard, elastic | 45 | 22 | 0.5 min | ~$4 |

(1,230 production deployments were *created* on each of the three projects. For
viewer and embed the gap to their 751 and 702 builds is Vercel auto-cancelling
a queued deploy when a newer commit supersedes it. Landing's 45 is a far wider
gap and a different mechanism entirely: its own `apps/landing/vercel.json` set
`ignoreCommand`, which overrides the dashboard step and path-scoped it. Cost
split assumes standard = 4 vCPU; the totals reconcile to $269 at
~$0.0094/CPU-min.)

**Path scoping is not the lever, and measuring it is what proved that.** A
`scripts/vercel-ignore-build.sh` once existed to scope each project to the paths
it consumes. It was never wired into any project, and replaying its pathspecs
over the 1,233 real commits shows why it would not have helped much: **87% touch
viewer-relevant paths and 69% touch embed-relevant paths**, because
`packages/**`, `rust/**` and the lockfiles are inputs to both apps. It bought
~13% / ~31% per commit.

And once builds are batched daily (§3a-fix) even that disappears. Replaying the
same pathspecs **per day** rather than per commit: every one of the 31 days in
the window contains at least one viewer-relevant commit, and at least one
embed-relevant commit. Path scoping would skip **0 of 31** nightly builds for
the two projects that are 98% of the bill. (Landing is the exception — relevant
on 21/31 days — but at 0.5 min a build that is about 3 cents a month.) The
script has been deleted rather than fixed; there is nothing left for it to
compose with. See §3a-fix.

### 3a-fix. The fix: `main` is no longer the Production Branch

All three projects now deploy from a **`production`** branch, and
`.github/workflows/deploy-nightly.yml` fast-forwards `production` to `main`
once a day at 05:45 UTC. That is one push a day, so one build per project per
day: **~1,500 builds/month → ~90**, roughly a 94% cut.

```text
main       ──●──●──●──●──●──●──●──●──  41/day, now PREVIEWS → skipped, $0
                ╲
production ──────●──────────────────●  1/day, fast-forward → 3 builds
            05:45 UTC          05:45 UTC
```

Consequences to know about:

- **`www.ifclite.com` can lag `main` by up to 24h.** That is the trade being
  made. To ship sooner, run the workflow manually (Actions → *Nightly Vercel
  Deploy* → Run workflow). That is the only hotfix path, deliberately.
- **A hotfix must land on `main` first.** The manual run takes a ref, but the
  workflow refuses one that is not already reachable from `main`, and the
  refusal is the point: deploying a side branch would put `production` on a
  commit `main` never contains — squash-merging that branch produces a
  *different* commit — so every later nightly would see `diverged`, refuse, and
  freeze all three sites until someone reconciled by hand.
- **This workflow cannot roll production backwards.** An older `main` commit
  passes the reachability check and then fails the fast-forward check as
  `behind`, on purpose: moving `production` back would break the
  fast-forward-only invariant and force a full rebuild of an old commit. To
  revert production fast, use Vercel's instant rollback — `vercel rollback
  <deployment-url>`, or promote a previous deployment in the dashboard. It
  re-points the alias at a build that already exists, so it takes seconds
  instead of minutes, which is what you actually want when the site is broken.
- **The nightly deploys the newest KNOWN-GOOD commit, not the tip.** A batch of
  ~40 merges goes live for 24h, so shipping a red tip costs a day rather than
  the ~20 minutes it did when every commit deployed. The run walks back from
  `main` and takes the newest commit whose `Build + WASM + Rust + Node` check
  succeeded; a commit whose gate is still running counts as not-yet-known-good
  and is skipped, which is routine for a tip that is minutes old.
  - It gates on that one composite check, not on "nothing failed anywhere":
    unrelated housekeeping lanes fail routinely (`4e08fe835` shipped fine with
    a red *Scan open PRs for CI-silent heads*), so the stricter rule would
    never find a deployable commit.
  - It reads **check runs**, not `commits/{sha}/status`. The combined Statuses
    API reported `success` for `4e08fe835` while its check runs held a failure.
  - Because of this, `behind` is now a NORMAL outcome: right after a deploy,
    production is usually ahead of the newest *known-good* commit while the
    tip's gate is still running. That is a quiet no-op, not a stuck branch.
  - `workflow_dispatch` exposes `require_green`; unchecking it deploys the ref
    as-is and says so with a warning. Scheduled runs always gate.
- **A bad commit that IS green is still live for up to 24h.** The cron fires
  just before the Zurich workday for exactly this reason.
- **`ifc-lite-git-main-ltplus.vercel.app` goes stale** — `main` is a preview
  branch now and previews are skipped. Use the production domains.
- The dashboard **Ignored Build Step is unchanged** on all three projects. It
  still reads `VERCEL_ENV`, and it is now what makes `main` pushes free.
  Landing is the one real behaviour change: `apps/landing/vercel.json` used to
  set `ignoreCommand`, which overrides the dashboard step, so landing was the
  only project running a path-scoped check (45 production builds against
  viewer/embed's 751/702) and the only one still building previews (190 of
  them). That override is deleted, so landing now rebuilds on every nightly
  whether or not `apps/landing` changed, and skips previews like the other two.
  At 0.5 min a build that is a few cents a month for one less special case.
- **The ref moving is not the deploy.** If a project's Production Branch is
  ever set back to `main`, it silently resumes building 41×/day and the saving
  quietly stops; if its Ignored Build Step is edited, it silently stops
  deploying. Both look like a green nightly, because the branch advances either
  way. So the workflow asks Vercel whether a deployment for the pushed commit
  actually exists, per project, and fails when one does not. That check needs a
  `VERCEL_TOKEN` repo secret; without it the run says so as a warning rather
  than passing quietly.
- `production` must only ever be fast-forwarded. The workflow refuses a push
  that is not a fast-forward rather than clobbering what is live.

### 3b. Build machines (dashboard, per project)

All three are on **standard**. Two notes worth keeping:

- The landing project's historical **Turbo 30-core** machine (9× the standard
  rate for a 0.5 min static build) is long gone. It is standard/elastic now.
- `ifc-lite-viewer-embed` had been auto-upgraded to **enhanced** by elastic
  selection with reason `short-build-duration`. That is backwards for cost: it
  had the *fastest* builds of the three (2.5 min median) and the *largest*
  CPU-minute bill, because enhanced doubles the per-minute rate. It is pinned to
  `standard` / `fixed` so elastic cannot re-upgrade it. If embed builds start
  timing out or OOM-ing, that pin is the first thing to reconsider.

### 3c. Prebuilt-WASM fast path — IMPLEMENTED (option A) ✅

> Since §3a-fix this barely fires on Vercel: a nightly build batches ~40 merges,
> so it will almost always contain a Rust change and fall through to the
> from-source path. The fast path still earns its keep in CI (§1a), where it is
> per-PR, and on CLI previews. The paragraphs below describe the per-commit
> world it was built for.
Every viewer/embed build was re-provisioning the WASM toolchain from scratch —
re-cloning emsdk and **re-downloading ~270 MB of wasm-binaries** + the Rust
toolchain — *despite* "Restored build cache from previous deployment". The
`/vercel/cache/emsdk` dir does not reliably survive between builds. That was
~40–60 s of wasted bootstrap on every viewer/embed build, on every commit.

*(Historical: `rust/wasm-bindings/Cargo.toml` enabled `manifold-csg-wasm-uu`
at the time, so emsdk was genuinely required to compile from source. Since M9
the kernel is pure Rust and the emsdk/cmake provisioning has been deleted from
`vercel-install.sh`/`vercel-build.sh` entirely — the fast path below now skips
only the Rust toolchain bootstrap.)*

**What was implemented:** `scripts/vercel-install.sh` now has an early fast path.
It computes `@ifc-lite/wasm@<version>` from `packages/wasm/package.json`, makes
the tag reachable (best-effort `git fetch`), and only when `git diff` proves
`rust/** + Cargo.{toml,lock} + rust-toolchain.toml + scripts/build-wasm.sh` are
**byte-identical to that release tag**, it runs `scripts/fetch-prebuilt-wasm.mjs`
to drop the published bundle into `packages/wasm/pkg/` and skips the entire
Rust/emsdk bootstrap. The from-source build phase then no-ops via the existing
soft-skip in `build-wasm.sh` (no wasm-pack on PATH + artifact present → success).

**Why it's safe:** any uncertainty — version unreadable, tag not reachable in
Vercel's shallow clone, npm 404, fetch failure, or *any* Rust change since the
release — falls through to the unchanged from-source build. It can never ship a
stale WASM bundle. On Rust-changing PR previews it compiles from source exactly
as before; on the ~2/3 of deploys that don't touch Rust it skips minutes of work.

**Needs one real-deploy check:** confirm Vercel's shallow clone lets the
`git fetch` of the release tag succeed (logs will print `🅰 … using prebuilt`
vs `🛠 … building from source`). If tags are unreachable, set the project's
Git "fetch tags"/depth or switch to the alternative below.

**Alternative (B), not used:** make `/vercel/cache/emsdk` persist (pin emsdk,
shrink the cached prefix, verify survival). Keeps from-source on every preview;
needs cache-size investigation. Kept here in case (A)'s tag fetch proves flaky.

### 3d. On-demand previews via CLI

Preview builds are turned off on all three projects through each project's
**Ignored Build Step** (dashboard `Settings > Git`), not the
`previewDeploymentsDisabled` flag. So a PR-branch push does not spin up the
~several-minute viewer/embed WASM preview. Since §3a-fix this also covers
`main`, which is a preview branch now — production moves only when
`.github/workflows/deploy-nightly.yml` advances the `production` branch.

When a branch does need a preview, trigger one from the CLI:

```
vercel link      # once per app dir: pick the project (.vercel is gitignored)
vercel deploy    # prints a preview URL; add --prod to ship to production
```

Link from each project's **Root Directory** (three separate Vercel projects, so
each needs its own `vercel link`):

```
ifc-lite (viewer)         root dir: repo root
ifc-lite-viewer-embed     root dir: apps/viewer-embed
ifc-lite-dev (landing)    root dir: apps/landing
```

The surest path, and the way to skip the remote Rust+WASM compile, is to build
locally and upload the output: the Ignored Build Step gates only remote builds,
so a prebuilt upload is never skipped by it. You already have a built
`@ifc-lite/wasm` from `pnpm build` / `pnpm dev`. Run `vercel pull` first so the
build uses the project's current settings and env vars:

```
vercel pull                                       # sync project settings + env
vercel build && vercel deploy --prebuilt --archive=tgz
```

---

## 4. Pricing reference (verified against vendor docs, 2025/2026)

- Depot: $0.004/min base (2 vCPU); minutes × `vCPU/2`; cache $0.20/GB after 25 GB
  included; retention 7/14/30 d (default 14, no size cap). Native arm64 = Graviton.
- GitHub Actions: standard runners free + unlimited on public repos; larger
  runners always billed even on public repos (Linux 4-core $0.012, 8-core $0.022).
- Vercel builds: Standard 4-core $0.014/min, Enhanced 8-core $0.03, Turbo 30-core
  $0.126, Elastic $0.0035/CPU-min. Remote Cache auto-enabled on Vercel builds.
  Billed as the single `buildCpuMinutes` SKU. The Ignored Build Step gates
  *which* deploys build; the Production Branch gates *how often* (§3a-fix), and
  on a repo merging 41 PRs/day the second one is worth ~10× the first.
