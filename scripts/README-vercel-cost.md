<!--
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# CI/CD cost playbook (Vercel · Depot · GitHub Actions)

`ifc-lite` is a **public** repo with very high activity (~100 merged PRs and
~250 commits to `main` per month). That combination makes CI/CD spend the
dominant infra cost. This doc records why the spend happens and the levers
that control it. It is referenced from `scripts/vercel-ignore-build.sh` and
`.github/workflows/test.yml`.

Snapshot that triggered this work (June 2026):

| Provider | ~Monthly | Why |
|---|---|---|
| Depot (GitHub Actions runners + cache) | ~$147 | Heavy CI jobs run on **paid** Depot runners; cache grew to 173 GB |
| GitHub Actions | **$0** | Public repo → standard runners are free + unlimited |
| Vercel (builds) | ~$165 | 3 repo-linked projects rebuild on **every** commit; 1 was on the 30-core Turbo machine |

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

Three repo-linked projects, all building on **every** push (preview + prod),
because Vercel's monorepo default deploys every connected project per commit:

| Project | Domain | Build machine | What it builds |
|---|---|---|---|
| `ifc-lite` | ifc-lite-ltplus.vercel.app | Standard 4-core ✅ | Viewer (Rust+WASM from source) |
| `ifc-lite-viewer-embed` | embed.ifclite.com | Standard 4-core ✅ | Embed (Rust+WASM from source) |
| `ifc-lite-dev` | **ifclite.dev** (landing) | **Turbo 30-core** 🔴 | Static landing — `0 tasks, 182 ms` |

Two structural problems:

1. **No per-project scoping.** A pure-geometry Rust PR rebuilt the *landing
   page*; a landing copy-edit could spin up the *viewer*. Fixed in code:
   `scripts/vercel-ignore-build.sh` now takes a scope arg (see §3a).
2. **The landing page runs on the 30-core Turbo machine** ($0.126/min — 9× the
   Standard $0.014/min rate) to copy static files. Pure waste; fix in dashboard.

### 3a. Set each project's Ignored Build Step (dashboard → Settings → Git)

GOTCHA — Vercel runs the Ignored Build Step from each project's **Root
Directory**, not the repo root. So the command path is relative to that root.
The viewer's root is `./`; embed's is `apps/viewer-embed` (hence `../../`);
landing's is `apps/landing` (so it just checks `.`, its own folder).

```
ifc-lite (root ./)                  →  bash scripts/vercel-ignore-build.sh viewer
ifc-lite-viewer-embed (apps/viewer-embed) →  bash ../../scripts/vercel-ignore-build.sh embed
ifc-lite-dev (apps/landing)         →  git diff HEAD^ HEAD --quiet -- .
```

The landing page is static and depends only on `apps/landing`, so the plain
`git diff -- .` (`.` = the landing folder, since the step runs from there) is
simpler than the script. viewer/embed need the script because their relevant
inputs span `rust/**`, `packages/**`, and config.

After this, `ifc-lite-dev` skips ~all commits (only rebuilds when
`apps/landing` changes), and viewer/embed stop rebuilding for each other.

### 3b. Build machine + previews (dashboard, per project)
- **`ifc-lite-dev` → Build machine: Standard or Elastic** (NOT Turbo). It's a
  182 ms static build; 30 cores is pure cost.
- **`ifc-lite-dev` → disable preview deployments** (Settings → Git → Deploy only
  production, or ignore non-`main` refs). A landing page rarely needs PR previews.
- `ifc-lite` and `ifc-lite-viewer-embed`: keep **Standard 4-core** (correct).

### 3c. Prebuilt-WASM fast path — IMPLEMENTED (option A) ✅
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

---

## 4. Pricing reference (verified against vendor docs, 2025/2026)

- Depot: $0.004/min base (2 vCPU); minutes × `vCPU/2`; cache $0.20/GB after 25 GB
  included; retention 7/14/30 d (default 14, no size cap). Native arm64 = Graviton.
- GitHub Actions: standard runners free + unlimited on public repos; larger
  runners always billed even on public repos (Linux 4-core $0.012, 8-core $0.022).
- Vercel builds: Standard 4-core $0.014/min, Enhanced 8-core $0.03, Turbo 30-core
  $0.126, Elastic $0.0035/CPU-min. Remote Cache auto-enabled on Vercel builds.
  "Skip unaffected projects" / Ignored Build Step is the monorepo cost lever.
