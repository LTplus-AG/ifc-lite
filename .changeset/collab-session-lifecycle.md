---
"@ifc-lite/collab": minor
---

Session teardown in `@ifc-lite/collab` now settles everything it leaves behind.

- `createWebSocketProvider({ connect: false })` reports `'offline'` until `connect()` is called, rather than `'connecting'`. A destroyed provider rejects a `whenSynced` that has not settled yet, where it used to hang. Its `destroy()` is idempotent and releases status listeners, and `connect()` after destroy no longer opens a socket.
- `CollabSession.dispose()` is idempotent. It rejects a pending `whenSynced` with the new `CollabSessionDisposedError` and stops notifying status listeners. After dispose, `seed` and `transact` throw `CollabSessionDisposedError` instead of writing to a torn-down doc. The new `disposed` flag and `onDispose(listener)` let owners tie their own cleanup to the session.
- `attachHistorySidecar` runs captures one at a time, so each diff is taken against the previous recorded entry. Timer ticks are skipped while a capture is in flight. The driver detaches itself when its session is disposed. A capture that would run after detach rejects with `HistoryDriverDetachedError` and records nothing.
