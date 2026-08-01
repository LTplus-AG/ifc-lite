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

## Pull requests

- Branch from `main`; one focused change per PR.
- Fill in the PR template. Green CI plus one approval plus resolved
  conversations are required to merge (squash only).
- Keep client and project identifiers out of code, tests, commit messages, and
  PR text.

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
