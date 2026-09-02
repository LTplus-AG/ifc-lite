# Contributing to ifc-lite

Thanks for your interest. ifc-lite is a client-side IFC/BIM toolkit: a WebGPU
viewer, a pure-Rust exact geometry kernel compiled to WASM and native, and a set
of published `@ifc-lite/*` packages plus a CLI, MCP server, and HTTP server.

`AGENTS.md` is the source of truth for architecture, invariants, and the review
conventions ("house rules"). Read it before a non-trivial change. This file is
the short version for getting set up and opening a PR.

## Setup

```bash
pnpm install
pnpm fixtures        # fetch test models (tests skip cleanly when absent)
pnpm dev             # run the viewer
```

Rust lives under `rust/` and `apps/server`; the TS packages under `packages/`
and `apps/`. The WASM bundle is rebuilt with `pnpm build:wasm` (wraps
`scripts/build-wasm.sh`; needs the nightly pinned in `rust-toolchain.toml` plus
`wasm-pack`), or fetched prebuilt from npm with `pnpm build:wasm:fetch`; the
committed `pkg/ifc-lite.d.ts` type surface is what lets `pnpm typecheck` run
without the Rust toolchain.

## Test

```bash
pnpm test                  # TS (turbo)
cargo test --workspace     # Rust (use test, not check: check skips #[cfg(test)])
pnpm test:wasm-contract    # the real wasm boundary (pnpm build:wasm first, or it skips)
```

A change ships with a test that asserts real behavior through a fixture or a
stated invariant. Regression tests cite the issue or PR number.

## House rules (self-policed, not linted)

- No `as any` / `@ts-ignore`; fix the types or add a `.d.ts`.
- No silent `catch {}`; log or rethrow.
- Split modules over ~400 non-generated lines.
- Package-specific deps go in the consuming package, never the root.
- Never run a repo-wide `cargo fmt`; format only the lines you touch.
- Never break the cross-platform determinism manifests. A legitimate
  geometry-output change re-pins both `mesh_determinism.json` and
  `mesh_determinism.wasm32.json` (see `docs/architecture/mesh-determinism.md`).

## Published packages

A change to any published `packages/*` needs a changeset:

```bash
pnpm changeset               # describe the change; pick the bump level
pnpm api-surface:update      # if you added/removed/renamed an export
```

Never hand-edit versions or `CHANGELOG.md`.

## Working with an AI agent

Most contributions here are agent-written, including the maintainer's own. There is
no disclosure rule and no point in one. Two rules replace it.

**You are accountable for the PR, and the test is answering, not authorship.** When
review asks a question, answer it with evidence: a test, a run, a measurement, a model
file that reproduces it. "The agent wrote it" is never an answer. "Here is the run
that proves it" always is. You do not need to be able to write the code. You do need
to be able to demonstrate what it does. Unanswered questions block the merge.

**Supply the ground truth your agent cannot.** The most valuable thing you bring is a
real IFC file from a real authoring tool, a measurement, a screenshot, a reproduction.
An agent can write a plausible test all day; it cannot produce a Vectorworks export
that georeferences wrong. Contributions that carry one of those are worth more than
another sweep.

## Picking what to work on

**Default lane: your PR closes an issue labelled `ready`.** `ready` is applied by the
maintainer and means: in scope, wanted now, scoped. That label is how project direction
gets set, and it is the one thing not delegated. `scripts/check-issue-queue.mjs` checks it on every PR, and **prints which mode
it is in**. Read that line rather than this one: the mode lives in
`scripts/issue-queue.config.json` and this paragraph cannot be kept in sync with
it. While the check reports ADVISORY it prints its verdict and does not fail the
job, so a green tick does not mean the rule was met. A genuine drive-by fix can be waved through with the
`unqueued` label, applied by the maintainer.

**Filing issues is unrestricted and welcome.** An audit that produces twenty good
issue reports is a real contribution. Filing is not claiming, and an unlabelled issue
is not yet a work item.

**One defect class per issue, one issue per PR.** A class found once and paid for N
times is N review contexts for one decision. Fix the class, not the call site. Past
roughly 1,500 changed lines, stack PRs against the same issue instead of shipping one
diff nobody can review.

**A sweep needs a charter.** Audit-driven work is welcome and has produced some of the
best work in this repo. It also has no natural stopping point, so it needs an issue
naming one: what is being swept, and what ends it.

**New contributors start with one PR open at a time.** Not a punishment and not a
judgement of your code: with a single human reviewer, review is the scarce resource,
and an unreviewed merge is worse for the project than a slow one. The limit rises as
merges land clean.

## Pull requests

- Branch from `main`; one focused change per PR.
- Fill in the PR template. Green CI plus one approval plus resolved
  conversations are required to merge (squash only).
- Keep client and project identifiers out of code, tests, commit messages, and
  PR text.

## The two review checks on your PR

Two checks you will not have seen elsewhere. They are **one review lane and one
verification check**, not two reviewers. (`PR review signal` is a different,
older check — and unlike these two, that one *is* required to merge.)

**`Claude review`** reads your diff and posts findings as inline comments, plus
one summary comment. An empty result is a normal, successful review.

It only ever sees the diff, never the rest of the file. So if it tells you the
change "lacks" a null check, an `await` or an error path that exists three lines
above the hunk, it is wrong and you should say so — it is instructed not to make
that claim, and doing it anyway is a bug worth reporting.

It does not run on every PR. **Drafts** and PRs from **forks** are excluded (a
fork's token cannot post); for those two, `Review posted` reports what it found
but does not fail your PR, and CodeRabbit reviews you as before.

The lane also sits behind a repository switch. If that is ever turned off,
`Review posted` **does** start failing PRs — there is no exemption for it, on
purpose, because a whole repository going red is the intended signal that the
reviewer is gone. That is a maintainer's problem, not yours; say so on the PR.

**`Review posted`** does not review anything. It checks that a review actually
*reached* your PR, for your exact head commit, by looking for a marker the
reviewer writes only after its comments are confirmed posted. It exists because
a review job can exit successfully having posted nothing, and then "no findings"
and "nothing ran" look identical.

### What to do when they are red

| what you see | what it means |
|---|---|
| `Claude review` failed | The reviewer could not run — usually a drained quota or an expired token. **Almost never about your code.** Re-run it; if it recurs, say so on the PR. The one exception: a diff over 600 KB of patch text is refused as too large, and re-running will not help — split the PR. |
| `Review posted` says `NOT_POSTED` | No **completed** review was verified for this commit. That covers both "nothing was posted" and "something was posted without a valid end-of-review marker" — a partial run looks like the second. Usually the same cause as above. Re-run the review job. |
| `Review posted` says `STALE_REVIEW` | A review exists, but for an older commit. Push or re-run so the current head gets one. |
| `Review posted` says `nothing-to-review` | Your PR changes only lockfiles, generated code, snapshots, fixtures, build output, images or other binary assets. Nothing to read, so nothing was read. This **passes**. |
| any other `Review posted` verdict — `MARKER_MALFORMED`, `FINDINGS_NOT_POSTED`, `COMMENTS_TRUNCATED`, or a `❌` refusal | The reviewer or the gate itself misfired, not your code. Most of these print a `REMEDY:` line saying what to do, and for the common ones it is "re-run the review job". `MARKER_MALFORMED` is not one of those: it means the reviewer wrote a marker the gate cannot parse, which needs fixing rather than retrying. The refusals (`NO_PR`, `NO_SHA`, `NO_REPO`, `BAD_CONFIG`, `GH_ERROR`) print no remedy at all — flag them on the PR. |
| your PR is a **draft**, or from a **fork** | `Review posted` reports what it found but does **not** fail the job, because the lane never runs on either and no re-run could produce a marker. Marking a draft ready for review gets it a real review. |

Neither check is a merge blocker today. `Review posted` is deliberately not in
the required set while the lane is new.

### Why CodeRabbit sometimes says "Review skipped"

**The Claude-lane stand-down is currently OFF.** `.coderabbit.yaml` carries the
`!llm-reviewed` rule commented out under a block dated 2026-09-01, so both
reviewers look at every PR today. If you see `Review skipped: auto reviews are
limited based on label configuration`, that is the separate `!low-risk` rule,
which is live.

Check `.coderabbit.yaml` rather than this paragraph — it is the fact, and this
section has been wrong about it before.

The rest of this section describes how the stand-down behaves **when it is
re-enabled**, because the label machinery is live either way:

- When `Review posted` confirms a review reached your head, the workflow *tries*
  to add an `llm-reviewed` label, and clears it on every new commit. It only
  tries: a `nothing-to-review` pass writes `covered=false` and no label is added,
  and a fork's token cannot write labels at all. The run log says which happened.
- It would not usually apply to the commit you just pushed. CodeRabbit reads
  labels when your push arrives; the label is cleared on that push and only goes
  back on minutes later, once the review is verified. The saving would show up
  over a PR's life, not on every push.
- No label means CodeRabbit reviews the PR.

Fork PRs never get the Claude lane at all — a fork's token cannot post — so they
stay on CodeRabbit and `Review posted` will not fail them.

If your push fails with `You need Push access to upload Git LFS objects`: this
repo retired Git LFS but its history still holds LFS pointer blobs, and a
`pre-push` hook left by `git lfs install` asks git for the objects being pushed
with `--not --remotes=<remote>`. With no remote-tracking refs for the remote you
are pushing to, that widens to the whole history, so git-lfs queues those old
pointers for upload and the push dies uploading them. It only affects clones
predating the retirement, or clones where `git lfs install` was run; a clone
made today gets no LFS hooks. `pnpm check:git-lfs` reports whether your clone
has the leftover hooks and never changes anything.

`git push --no-verify` gets the push out without changing anything on disk, but
it skips **every** pre-push hook, not only the Git LFS one, so run whatever
checks your other hooks would have run before you rely on it. Use it for this
failure, not as a habit.

The lasting fix is `git lfs uninstall --local`, but check what you are about to
delete first: `--local` scopes the config edit, not the hook removal, and the
hooks it removes are the ones in whatever `core.hooksPath` resolves to. That is
the main clone's `.git/hooks` for every linked worktree, and can be another
repository entirely if `core.hooksPath` is set. Run
`git rev-parse --path-format=absolute --git-path hooks` to see the directory.

If another checkout shares it, remove just the `pre-push` file there instead,
and read the file before you delete it: a hook that only carries git-lfs's
guard and `git lfs pre-push "$@"` is safe to drop, but if yours also runs your
own commands, delete only the git-lfs lines and keep the rest. Details in
[docs/contributing/setup.md](./docs/contributing/setup.md#push-fails-with-you-need-push-access-to-upload-git-lfs-objects).

By contributing you agree your contributions are licensed under the repository
license and that you follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
