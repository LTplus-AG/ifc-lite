# IFC-Lite Collaborative 3D Example

Two-tab live 3D editing built on `@ifc-lite/collab` (the CRDT runtime) and
`@ifc-lite/collab-server` (the websocket sync server), rendered with Three.js.

**What it shows:** each entity is a real 3D box on a floor grid. Position, size,
rotation, and color are CRDT attributes - drag a wall in tab A and the same wall
moves in tab B over the websocket server. Peer selections are outlined in each
user's color, and undo/redo is scoped per tab.

## How it works

- `createCollabSession` from `@ifc-lite/collab` opens a Yjs-backed session and
  connects to the server over a websocket (`ws://<host>:1234`, room
  `demo/three-walls`).
- Entity creates, deletes, and attribute edits go through the collab helpers
  (`createEntity`, `deleteEntity`, `setAttribute`, `iterEntities`, ...), so every
  change is a CRDT operation that merges across tabs.
- Presence and conflict UI are wired via `mountPresenceInViewer` and
  `createConflictUIBridge`; local history uses `MemoryHistorySidecar`.

## Quick start

The example needs the sync server running alongside the Vite dev server. The
simplest path is the repo-root driver, which builds the collab packages, boots
`@ifc-lite/collab-server` on `:1234`, and starts this example on `:5175`:

```bash
# from the repo root
pnpm collab:demo:3d
```

Then open `http://localhost:5175` in **two browser tabs** and move walls to see
the changes sync live.

To run just the frontend (assuming a collab server is already listening on
`:1234`):

```bash
# from examples/threejs-collab
pnpm dev
```

## Key files

| File | Purpose |
|------|---------|
| `src/main.ts` | Three.js scene, collab session, drag-to-edit, presence + conflict UI |

## License

MPL-2.0
