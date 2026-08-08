---
"@ifc-lite/viewer-core": patch
---

Fix `startViewerServer` hanging forever if the caller's `onReady` callback threw. The executor for the returned promise only took a `resolve` parameter; `onReady` runs inside the `server.listen` callback, outside any try/catch the caller can see, so a throw there silently skipped `promiseResolve` and the returned promise never settled. It now rejects with the thrown error, and closes the already-bound server first so the rejection doesn't leak a listening socket.

Also fix the same class of hang on a `server.listen()` bind failure (e.g. `EADDRINUSE`): a bind failure emits `error` and never runs the `listen` callback, so the returned promise hung forever with no way to observe the failure. It now rejects with the underlying error; since the server never bound on this path there is no listening socket to close.
