<!-- Keep this focused: one change per PR. Delete sections that do not apply. -->

## What and why

<!-- The change and the problem it solves. Link the issue if there is one. -->

## How it was verified

<!-- Commands run and what you observed. Not "should work". -->

- [ ] `cargo test --workspace` (Rust) and/or `pnpm test` (TS) pass locally
- [ ] Geometry/WASM change: ran `scripts/build-wasm.sh` then `pnpm test:wasm-contract`

## Checklist

- [ ] A test asserts the new behavior through a fixture or a stated invariant
- [ ] Published `packages/*` touched: added a changeset (`pnpm changeset`) and, if
      the export surface changed, ran `pnpm api-surface:update`
- [ ] Geometry-output change: re-pinned **both** `mesh_determinism.json` and
      `mesh_determinism.wasm32.json` (or: no geometry output changed)
- [ ] House rules: no `as any` / `@ts-ignore`, no silent `catch {}`, no module
      pushed past ~400 non-generated lines, no repo-wide `cargo fmt`
- [ ] No client or project identifiers in code, tests, commit messages, or this PR
