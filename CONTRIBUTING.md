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
and `apps/`. The WASM bundle is rebuilt with `scripts/build-wasm.sh` (needs the
pinned nightly + `wasm-pack`); the committed `pkg/ifc-lite.d.ts` type surface is
what lets `pnpm typecheck` run without the Rust toolchain.

## Test

```bash
pnpm test                  # TS (turbo)
cargo test --workspace     # Rust (use test, not check: check skips #[cfg(test)])
pnpm test:wasm-contract    # the real wasm boundary (build-wasm.sh first, or it skips)
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

By contributing you agree your contributions are licensed under the repository
license and that you follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
