# `@ifc-lite/collab` demo

Two-tab live demo of the CRDT runtime + presence overlay.

> **Runs inside the ifc-lite monorepo only.** This example depends on
> `@ifc-lite/collab` via `workspace:*` and on the locally built
> `@ifc-lite/collab-server`, so it cannot be copied out and installed on its
> own. Run it from a checkout of this repository.

```sh
# from the repo root, builds + boots the websocket server + starts Vite
pnpm collab:demo
```

Then open `http://localhost:5174` in **two browser tabs** to see:

- Each tab's cursor live in the other tab (presence overlay).
- "Add wall" instantly mirrored across tabs (CRDT entity creates).
- "Force conflict" shows the conflict bridge fire `open` and surface
  `keep mine` / `accept theirs` buttons.
- "Capture snapshot" appends a history entry; the sidecar keeps an
  IFCX timeline.
- Undo / redo scoped per-tab via `Y.UndoManager` + local origin.

From `examples/collab-demo`, `pnpm build` typechecks and bundles the demo to
`dist/`; `pnpm typecheck` runs `tsc` alone.

For the wider testing guide see `docs/contributing/collaboration-testing.md`.
