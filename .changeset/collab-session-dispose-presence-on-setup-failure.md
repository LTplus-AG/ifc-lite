---
"@ifc-lite/collab": patch
---

Dispose the presence object (and its two live timers — the awareness eviction sweep and y-protocols' own outdated-clients timer) when `createCollabSession` fails after `createPresence` has already run, instead of leaking it. `presence` is constructed before either persistence provider comes up; if the IndexedDB or WebSocket provider then throws (for example `createIndexedDbProvider` rejecting outside a browser, where `indexedDB` is undefined), the function rejected without a `session` object for the caller to call `.dispose()` on, so nothing ever cleared those timers. In a browser this went unnoticed because navigating away reclaims everything; in a Node test process it kept the event loop alive indefinitely — `startCollab`'s entry-race regression test, run together with its sibling collab test files in one process, would pass every assertion and then never let the process exit.
