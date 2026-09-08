<!-- Keep this focused: one defect class per PR. Delete sections that do not apply. -->

## What and why

<!--
The change and the problem it solves.

Closes #<issue>   <- required unless this PR carries the `unqueued` label.
                     The issue needs the `ready` label; a maintainer applies both.
                     See CONTRIBUTING.md "Picking what to work on".
                     The `Issue queue` check prints its own mode. While it says
                     ADVISORY, a green tick does not mean the rule was met, so
                     read the verdict rather than the tick.
-->

## How it was verified

<!--
What you RAN and what you OBSERVED. Not "should work", and not a restatement of the
diff. A ticked box below is not evidence; this section is.

If the PR claims user-visible behaviour, show that behaviour: the command and its
output, the fixture or model file, the measurement, the screenshot. Name something a
reader could re-run.

You do not need to have written the code. You do need to be able to demonstrate what
it does, and to answer follow-up questions with evidence rather than another
generation.
-->

- [ ] `cargo test --workspace` (Rust) and/or `pnpm test` (TS) pass locally
- [ ] Geometry/WASM change: ran `scripts/build-wasm.sh` then `pnpm test:wasm-contract`

## Checklist

- [ ] A test asserts the new behavior through a fixture or a stated invariant, and
      that test FAILS against the unfixed code (say how you checked)
- [ ] Published `packages/*` touched: added a changeset (`pnpm changeset`) and, if
      the export surface changed, ran `pnpm api-surface:update`. The bump level
      follows AGENTS.md, not generic semver: never `patch` when the surface shrank
- [ ] Geometry-output change: re-pinned **both** `mesh_determinism.json` and
      `mesh_determinism.wasm32.json` (or: no geometry output changed)
- [ ] House rules: no `as any` / `@ts-ignore`, no silent `catch {}`, no module
      pushed past ~400 non-generated lines, no repo-wide `cargo fmt`
- [ ] No client or project identifiers in code, tests, commit messages, or this PR
