# Lane brief: Rust sweep campaign (charter #7670)

You are an implementation lane in a coordinated campaign. A coordinator session (b066fae6) owns the ledger, adversarial review and merging. Follow this brief exactly.

## 0. Read first
1. Your WP issue: `gh issue view <N>`. It holds the full text of every finding you own.
2. The charter #7670: §1.2 (the R/X/G evidence rules), §1.3 (every-PR rules) and §1.4.
3. `AGENTS.md` and `rust/AGENTS.md` in the repo. They override this brief where they conflict.

**Process safety:** never `pkill`/`killall` by pattern on this shared host; kill only PIDs you started (see COORD-RULES).

## 1. Setup
```bash
REPO=/home/louistrue/.t3/worktrees/ifc-lite/t3code-b066fae6   # any checkout of the repo works for `git worktree`
WT=/home/louistrue/wt/sweep-<wp>-b066fae6
git -C $REPO fetch origin main
git -C $REPO worktree add --no-track $WT -b sweep/<wp>-<slug> origin/main   # --no-track: the branch must NEVER track origin/main
cd $WT || exit 1   # NEVER continue if the worktree add failed: the symlink step would land in the coordinator checkout
[ "$(git rev-parse --show-toplevel)" = "$WT" ] || exit 1
mkdir -p tests/models && for d in /home/louistrue/wt/.fixtures/models/*; do b=$(basename "$d"); case "$b" in README.md|manifest.json) continue;; esac; ln -sfn "$d" tests/models/; done   # dirs AND top-level fixture files (e.g. AB22.ifc); README.md/manifest.json are tracked and must stay
git status --short tests/models   # must print nothing; never commit fixture symlinks
# The cache is verified against the manifest. If origin/main's tests/models/manifest.json changed, refresh it first:
#   cp <worktree>/tests/models/manifest.json /home/louistrue/wt/.fixtures/models/ && (cd /home/louistrue/wt/.fixtures-root && node scripts/fixtures/fetch-fixtures.mjs && node scripts/fixtures/fetch-fixtures.mjs --check)
export CARGO_TARGET_DIR=/home/louistrue/wt/.targets/<wp>  CARGO_BUILD_JOBS=6  PATH=$HOME/.cargo/bin:$PATH
export CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0   # disk policy, see below
```
**Disk policy (mandatory; the machine is shared and was at 91%):**
- Build lean: no incremental caches and no debuginfo in dev/test builds, using the exports above. A full-debug target was 45–54 GB per lane.
- **Scratch builds reuse the lane's single `CARGO_TARGET_DIR`; BASE builds for base-vs-branch evidence use a separate `.targets/<wp>-base`, deleted right after (shared targets have silently served branch artifacts as base).** Never create extra `.targets/<wp>-base`, `-probe-*` or `-scratch-*` dirs. The only exception is a separate profile run such as `--profile profiling`, which lands in its own subfolder of the same target dir anyway.
- Remove scratch worktrees (base checkouts, proof worktrees) as soon as you have the numbers: `git worktree remove --force <dir>`.
- Before any full workspace build, check `df -h /`. If less than 60 GB is free, stop and report to the coordinator rather than filling the disk.
- The coordinator deletes your worktree and target dir when your PR merges or closes. Leave nothing else behind.
- **Claim the issue.** Run `gh issue edit <N> --add-assignee louistrue --add-label claimed:session-b066fae6`, then comment `Claiming. Session b066fae6 lane <wp>, branch sweep/<wp>-<slug>.`
- **Stay in your files.** Touch only files your WP owns; the issue and the ledger hot-file table list them. If you must edit a file another wave-1 WP owns (see the ledger), stop and report it to the coordinator in your final message. Never edit that file silently.

## 2. Verify before fixing
The review was read-only and `main` has moved since. For every finding in your issue:
1. **Re-check the cited code on current `main`.** If it is already fixed or the claim is false, record it as `rejected` with evidence (file:line, a test, or a run) in the PR's "Findings" table.
2. **Bug/Quirk findings:** write the regression test *first* and show that it fails on base (paste the failure output into the PR). The test name or a comment cites the finding ID and the issue number. Tests go through a real fixture or a stated invariant, never a mock tautology.
3. **DRY / drift audit, which is mandatory.** Before fixing, `rg` the whole workspace (all `rust/*` crates, `apps/server`, and the TS twin under `packages/` where one exists) for every other copy of the defective logic. Either fix every copy, or route them all through one home. List every site found and what you did with it in the PR's "Sibling audit" section. A fix that leaves a drifted copy behind will be rejected in review.

## 3. Implement
- **Keep it minimal and DRY.** Where the codebase already has a home for a concept (`core::limits`, `processing::style`, `transform.rs`, ...), use it. Introduce a new home only when your WP says so.
- **Pick exactly one PR class** (charter §1.2): R (refactor), X (behaviour change) or G (gate). Wave-1 S/B work is X.
- **Bounding walks:** follow the AGENTS.md "Bounding walks" rules (depth cap vs visited set vs work budget, and the visited-set scope).
- **Formatting:** no repo-wide `cargo fmt`; format only the lines you touch.
- **New files:** add the MPL-2.0 header (`LICENSE_HEADER.md`) and stay under 400 lines.
- **Public Rust API changes in a published crate** (core, clash, geometry, processing, landxml, export, ffi, wasm): append an account to `rust-major-offset.json` (`latestBreak`), measured with `cargo semver-checks` where it is installed. Do not bump `majorOffset`; the coordinator does that.
- **wasm binding changes:** run `scripts/build-wasm.sh`, commit `packages/wasm/pkg/ifc-lite.d.ts`, run `pnpm api-surface:update`, add a `pnpm changeset`, and extend `pnpm test:wasm-contract` for changed entry points.
- **TS twin behaviour changes:** update the TS side in the same PR, with a parity vector and a changeset.

## 4. Evidence (put all of it in the PR description)
- **Every PR:** `cargo clippy --workspace --all-targets -- -D warnings` clean and `cargo test --workspace` green. Run both verbatim and paste the summary lines.
- **Public API change:** also build and test in-dir `rust/python` and `rust/csg-thread-bench`.
- **X PRs that change geometry or processing output:**
  - Run `cargo run --profile profiling -p ifc-lite-processing --example perf_probe -- <fixture> --iters 1 --fingerprint` on base and on the branch. Use the charter §1.2 corpus where the fixtures exist, and list which files moved and why.
  - Re-accept insta snapshots (`cargo insta review` or `INSTA_UPDATE=always`) only for the fixtures that legitimately moved, and justify each one.
  - Re-pin `mesh_determinism` only if the synthetic fixture moves, and then pin **both** manifests.
- **Perf-sensitive paths** (`rust/geometry`, `rust/processing`, `rust/core`): give a base-vs-branch perf verdict with `scripts/perf/probe.sh tests/models/ara3d/AC20-FZK-Haus.ifc --iters 5 --json`, run interleaved, plus a byte-identity statement.
- **User-visible fixes:** before/after evidence on a real model (tool output, numbers, or a dumped mesh stat).

## 5. PR
- **Pushing.** Always push with an explicit refspec: `git push -u origin HEAD:refs/heads/sweep/<wp>-<slug>`. Never run a bare `git push` until `git rev-parse --abbrev-ref @{u}` prints `origin/sweep/...`.
- **Title:** `fix(<area>): <what> (#<issue>)`. Use `refactor(...)` for R and `ci(...)` or `test(...)` for G.
- **Body sections:**
  - `Closes #<issue>` (or `Part of #<issue>` if the WP needs several stacked PRs)
  - Class
  - Findings table (id | status fixed/rejected | test | notes)
  - Sibling audit
  - Evidence
  - Risk
- **Body ending:** finish with the attribution lines:
  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- After `gh pr create`, run `gh pr edit <n> --add-assignee louistrue --add-label rust-sweep`.
- **Size:** keep PRs under ~1,500 changed lines. Above that, stack PRs against the same issue.
- **Do not merge.** The coordinator runs the adversarial review and merges.

## 6. CI: do NOT wait on GitHub
- **Run the FULL workspace test before every push.** Some gates live in other crates: the module-size ratchet is in `rust/processing/tests`, and API surface checks run from the workspace. A crate-only `cargo test -p X` is not enough, even for a one-crate change.
- **Local verification is the gate.** Before opening the PR, run the same commands CI runs for your change, verbatim and green. That means clippy `-D warnings` and `cargo test --workspace`, plus any `node scripts/check-*.mjs` guard your change could affect. Run `rg -l` over `.github/workflows/test.yml` for scripts that read the files you changed, then run those scripts and their `.test.mjs` locally.
- **Run the revert oracle locally.** It is the required job "Changed tests observe production" (step "Prove the changed tests observe the production change" in `.github/workflows/test.yml`); run the same script with the same arguments against origin/main. It reverts your production files and requires your changed tests to FAIL. If your PR adds a new production module or a new type/variant, the reverted tests will not compile or load, and the oracle reports this as inconclusive, which fails CI. Use the repo's evidence-mutation pattern instead: `tests/evidence/<area>-<issue>/` plus an `elif` in that step (see #7705 `tests/evidence/geometry-pool-7673/`). The local result must be OBSERVED before you push.
- **Report immediately after pushing.** Do not poll or wait on GitHub checks. The coordinator runs one shared CI watcher, and sends a lane back only when CI fails.
- **When you are sent back for a CI failure:** reproduce it locally, fix it, push and report again.

## 7. Final message to the coordinator
Report:
- the PR URL;
- for each finding: fixed / rejected / deferred, with a reason;
- the sibling-copy audit result;
- the evidence summary;
- CI state;
- **your own adversarial self-check:** the three most likely ways your fix is wrong, and why each is not the case;
- any file you needed that another lane owns.
