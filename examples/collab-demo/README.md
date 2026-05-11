# `@ifc-lite/collab` demo

Two-tab live demo of the CRDT runtime + presence overlay.

```sh
# from the repo root, builds + boots server + opens Vite
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

For the wider testing guide see `docs/guide/collab-testing.md`.
