# Agent notes: packages/collab-server

Supplements the root [AGENTS.md](../../AGENTS.md) Collaboration server section and pairs with [`packages/collab/AGENTS.md`](../collab/AGENTS.md) (the client CRDT library). Server-specific footguns:

- **`mergeUpdateFrames` must use `Y.mergeUpdates`, never byte-concatenate frames** (`src/persistence.ts`). `Y.applyUpdate` decodes only the first update in a naive concatenation and silently drops the rest, losing every edit after frame 1 on room reload (the #1501 data-loss class).
- **Persistence filenames use `encodeURIComponent(roomId)`** (`src/persistence.ts`), not the old sanitizer that mapped unsafe chars to `_` (which collided distinct rooms onto one log). `legacyLogPath` migrates pre-encoding logs on load/append and deletes them on compact. Any persistence-format change needs the same migrate-or-poison discipline or existing rooms lose history.
- **The server applies disk state with origin `load-from-disk`** (`src/room-manager.ts`) so `onDocUpdate` skips re-persist/re-broadcast. Reuse that origin when replaying persisted state; a plain apply echoes loaded state back out to clients.
- **E2E-encrypted rooms cannot be snapshotted server-side.** When a room uses the collab client's `e2e` (AES-GCM-256), the server routes ciphertext only; `src/snapshot-worker.ts` server-side IFCX export silently does not apply without key escrow.
- **Run the reference server with `pnpm collab:server`** (builds, then runs `dist/bin.js`). Env: `COLLAB_PORT` / `COLLAB_HOST` / `COLLAB_DATA_DIR` (default `./.collab-data`) / `COLLAB_MAX_ROOMS` (`src/bin.ts`). Test the pair with `pnpm test:collab`.
