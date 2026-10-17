# Coordinator rules for session 2 (coordinator thread b61983f5, taking over from b066fae6)

This covers the Rust sweep campaign, charter #7670, in repo LTplus-AG/ifc-lite.

## Read before you start
- `~/rust-review/LANE-BRIEF.md`: lane rules (worktree setup, fixtures, disk, evidence, PR format, push refspec).
- `~/rust-review/ADVERSARIAL-BRIEF.md`: review rules and the attack checklist.
- `~/rust-review/ledger.md`: decisions D1–D12, hot-file ownership and coordinator TODOs.
- `AGENTS.md` and `rust/AGENTS.md` in the repo.

Run `git worktree` commands against this checkout: `/home/louistrue/.t3/worktrees/ifc-lite/t3code-b066fae6`.

## Machine (shared by about 8 agents plus other sessions)
- Build env: `export PATH=$HOME/.cargo/bin:$PATH CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 RUST_TEST_THREADS=4 RAYON_NUM_THREADS=4`.
- **Load cap (since 2026-10-16 23:05):** test binaries default to one thread per core and rayon to all cores, so always set `RUST_TEST_THREADS=4 RAYON_NUM_THREADS=4` (perf-ratchet instruction counts are thread-independent). Run one heavy command at a time per agent, never two cargo invocations in parallel. Prefix heavy commands with `nice -n 10`.
- Each worktree uses one `CARGO_TARGET_DIR` under `/home/louistrue/wt/.targets/<name>`.
- Before a full build, check `df -h /`. Below 60 GB free, stop and report.
- When you finish, delete every scratch worktree and target dir you created. Keep a lane's own worktree and target until its PR merges.
- **Never** `git stash`, because the stash is shared across worktrees. Use a WIP commit instead.
- **Never** run `pkill`/`killall` with a pattern (e.g. `pkill -f "^cargo test"` kills every session's cargo on this shared host — this happened on 2026-10-16). To stop your own job, record its PID when you start it (`cmd & echo $! > /tmp/<lane>.pid`) and `kill $(cat /tmp/<lane>.pid)`; or kill the PIDs listed by `pgrep -f <your-unique-worktree-path>`.
- Never edit files inside another session's worktree.

## No new issues (user directive, 2026-10-17)
- Do NOT file new GitHub issues. Fix what you find in the PR you are working on, or, if truly out of scope, list it under "Not fixed" in your PR body / final report so the coordinator can assign it. Reviewers: fix small findings yourself on the branch.

## Git
- **Never** run a bare `git push`. Always push with an explicit refspec: `git push origin HEAD:refs/heads/<branch>`.
- New branches use `--no-track`.
- To refresh a PR branch, merge `origin/main` into it; do not rebase a branch that already has review comments.
- **No AI attribution (repo hook since 2026-10-17 09:31):** no `Co-Authored-By: Claude` trailers, no AI author/committer identity, no "Generated with Claude Code" line in PR bodies. The pre-push hook rejects such commits; rewrite only your OWN unpublished commits to drop a trailer. **Never work around the hook** (no API fast-forwards, no temp-branch tricks, no --no-verify). If it blocks because main's own history carries old trailers after you merged origin/main, rebase your branch onto origin/main instead of merging (allowed for branches without review comments that you own; reviewers: squash-merge does not need the branch to contain main — just verify the merged tree locally), or STOP and report.

## CI: GitHub is not the gate
Do not poll or wait on GitHub Actions. The **local full gate** is:
1. `cargo clippy --workspace --all-targets -- -D warnings`.
2. `cargo test --workspace` PLUS every feature-gated test command test.yml runs for the crates you touched (e.g. `--features triangulation-alt --test triangulation_invariance`, csg_* gates; rvt01 ALT pin broke main after #7809). This includes the module-size and function-length ratchets. **Also run `cargo test -p ifc-lite-export --features parquet-bos`** whenever export, geometry or processing changed: feature-gated goldens are not in the default run, and #7716 turned main red that way.
3. The revert oracle. This is the `revert-oracle` job in `.github/workflows/test.yml`, step "Prove the changed tests observe the production change". Run the same script with the same args against `origin/main`; it must report OBSERVED.
4. For changes under `rust/geometry`, `rust/processing` or `rust/core`, run the perf ratchet (`perf-ratchet` job in test.yml). Same script, run locally; it must pass with no ceiling raise.
5. Every `node scripts/check-*.mjs` guard in test.yml's `node-guards` job that reads a file you changed, plus its `.test.mjs` (ALWAYS run the `.test.mjs` too — a hand-edited allowlist row broke main via the regenerate-byte-for-byte self-test, #7814).
6. For TS twin changes, the package's tests and typecheck.
7. For wasm changes, `scripts/build-wasm.sh`, `pnpm api-surface:update` and `pnpm test:wasm-contract`.

If a GitHub check already failed on the PR, open that job's log with `gh run view --job <id> --log-failed`, reproduce it locally and fix it.

## Merging (only when the coordinator's prompt says you may)
- **Hook-safe merge recipe (since the attribution hook):** do NOT push a branch that merges origin/main (main's history trips the hook). Push only your own new commits on top of the PR head; verify the squash result locally with `git merge-tree --write-tree origin/main HEAD` (no conflicts) and gate a local, never-pushed merge of it; then `gh pr merge N --squash --admin --match-head-commit <pushed sha>`. If merge-tree conflicts, resolve on a local merge, then re-express the resolution as new commits on the PR head (or rebase if you own the branch).
- **Moving main (speed rule, 2026-10-17):** if a later origin/main merge only brings files/crates disjoint from the PR (`git diff --stat <old-base> origin/main` shares no crate with the PR), re-run only clippy -D warnings + `cargo test` of the PR's crates on the merged head, then merge. Don't loop full gates chasing main.
- The PR must have an `approve` adversarial-review verdict covering its content. A delta made only of a main merge or a mechanical test/snapshot fix keeps that approval.
- `origin/main` must be merged in, and the local full gate must be green on that exact head and pushed.
- Then run `gh pr merge <N> --squash --admin --match-head-commit <sha>`.
- Immediately after, confirm `origin/main` still builds by running clippy and the workspace test on the merge commit. If it is red, fix forward at once with a PR and report it.

## Benchmark hold (shared host with the #7292 session)
- **When the file exists:** if `/home/louistrue/wt/.bench-hold` is present, another session is running timing-sensitive benchmarks. Finish the command you are already running, but do NOT start any new cargo, wasm, pnpm build or test command.
- **How to wait:** wait until the file is gone, re-checking it every 60s. Spend the time reading code, reviewing diffs or writing PR text.
- **Before every heavy command:** BLOCK, do not just echo: `while [ -e /home/louistrue/wt/.bench-hold ]; do sleep 60; done` (or a Monitor with that until-loop). Echoing HOLD and continuing is a violation.

## rust-major-offset.json (since #7733)
- `majorOffset` is 11 and the crates are at 21.4.0.
- A new public-API break appends its account to the existing **break #11** `latestBreak` text and adds its refs.
- Never bump `majorOffset` and never open a break #12 until the 21.x crates publish.

## Base-vs-branch builds (stale-artifact hazard)
- **Use a separate target dir for base builds.** Base and branch builds that share one CARGO_TARGET_DIR have silently reused each other's artifacts: a "main" build ran branch code.
- **How:** for any base-vs-branch measurement (goldens, fingerprints, perf), build base in its own `.targets/<name>-base`, and delete it as soon as you have the numbers.
- **Check the build is really base.** Confirm it, e.g. with a golden or test that is known to differ between base and branch.
- **Precedence:** this overrides the LANE-BRIEF line about reusing the single target dir for base builds.
