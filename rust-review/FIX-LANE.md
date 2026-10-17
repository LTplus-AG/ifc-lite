# Fix-lane brief (Rust sweep, charter #7670, coordinator b61983f5)

You are a fix lane. Goal: close your assigned issues **fast and correctly**, in ONE PR, gated locally. GitHub CI is not the gate — never wait on it.

## Read
- Your issues: `gh issue view <N>` for each (full text + comments).
- `~/rust-review/COORD-RULES.md` (overrides everything below if they conflict) and `~/rust-review/LANE-BRIEF.md` §1 setup (worktree, fixture symlinks) and §2 (verify-before-fix, DRY sibling audit).
- Decisions D1–D48 at the end of `~/rust-review/ledger.md` (D3 fail closed + counter; D11/D13 non-finite; D14–D16; D21–D30 math/placement; D40–D48 data model).

## Hard rules
- Env for every cargo command: `export PATH=$HOME/.cargo/bin:$PATH CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 RUST_TEST_THREADS=4 RAYON_NUM_THREADS=4 CARGO_TARGET_DIR=/home/louistrue/wt/.targets/<lane>`; prefix heavy commands with `nice -n 10`; one cargo invocation at a time.
- **Never** `pkill`/`killall` by pattern; kill only PIDs you recorded. **Never** `git stash`. **Never** bare `git push` — use `git push origin HEAD:refs/heads/<branch>`. Branches `--no-track` off `origin/main`.
- Worktree from `/home/louistrue/.t3/worktrees/ifc-lite/t3-f5f203a6`: `git -C <that> worktree add --no-track /home/louistrue/wt/<lane> -b <branch> origin/main`.
- **Do NOT file new GitHub issues.** Anything truly out of scope goes in the PR body under "Not fixed".
- Stay inside your files. Before editing, run `gh pr list --search head:sweep/ --json number,headRefName` + `gh pr diff <N> --name-only` for open PRs; don't edit their files — if unavoidable, say so in the final report.
- Bench hold: `while [ -e /home/louistrue/wt/.bench-hold ]; do sleep 60; done` before heavy commands.
- Published-API break → append to break #11 in `rust-major-offset.json` (never bump, never break #12).

## Evidence (per bug)
Regression test first, show it fails on base (paste output), then fix. DRY: rg every copy (all rust crates, apps/server, TS twins in packages/) and fix all or route through one home. Corpus-affecting geometry change: base-vs-branch fingerprints (base in a separate `.targets/<lane>-base`, verified to be base, deleted after) — every mover justified, none empty.

## Local gate (all on the final head with origin/main merged in)
1. `cargo clippy --workspace --all-targets -- -D warnings`
2. `cargo test --workspace` (+ `cargo test -p ifc-lite-export --features parquet-bos` if export/geometry/processing changed)
3. Revert oracle exactly as CI: `node scripts/check-test-revert-oracle.mjs --base origin/main --ci --json` → OBSERVED (add `tests/evidence/<area>-<issue>/*.oracle.patch` + `test.yml` elif if a whole revert is INCONCLUSIVE)
4. Perf ratchet (test.yml perf-ratchet job, run locally) if rust/geometry|processing|core changed — no ceiling raise
5. Every `node scripts/check-*.mjs` guard reading a changed file + its `.test.mjs`
6. TS changes: that package's vitest + typecheck. Wasm changes: `scripts/build-wasm.sh`, `pnpm api-surface:update`, `pnpm test:wasm-contract`
7. Python: `cargo test --manifest-path rust/python/Cargo.toml` AND pytest via `uv venv` + `maturin develop` + `pytest rust/python/tests` whenever geometry, processing, core or python changed — the python goldens pin geometry output (issue_098 broke main this way)

## Finish
Push ONLY your own new commits (never a branch that has origin/main merged in — the attribution hook rejects main's history; verify integration locally with `git merge-tree --write-tree origin/main HEAD`). Open the PR (title `fix(<area>): ...`, body: Closes #N for each, findings table, sibling audit, evidence, "Not fixed"). NO AI attribution anywhere (no Co-Authored-By trailer, no "Generated with" line) — a repo pre-push hook rejects it. Do NOT merge. Final message: PR number, head sha, per-issue status, gate evidence, conflicts. Keep your worktree + target until merge; delete any scratch/base dirs.
