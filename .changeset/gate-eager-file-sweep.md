---
'@ifc-lite/plugin-api': minor
'@ifc-lite/source-dalux': patch
'@ifc-lite/source-fixture': minor
---

Gate the eager file-listing sweep on a new provider capability, `eagerFileSweep` (#2613).

`fetchAllFilePages` in the viewer's source browser used to drain every page of a container's `listFiles` up front, unconditionally, for any `FileSourceProvider` — capped at 100,000 items / 5,000 pages, throwing above that. That was fine while Dalux was the only provider (its own UI has no per-folder "load more files" concept, so a full sweep matches its UX), but a provider with a real per-folder file endpoint would have blocked a folder's first render on a full drain, and risked hitting the cap outright on a large folder.

`ProviderCapabilities` gains `eagerFileSweep?: boolean`, defaulting to off. Off means the viewer pages a container's files incrementally — one page loads eagerly, further pages via a new `loadMoreFiles` (mirroring the existing `loadMoreFolders`) — the same way folder listings already work. `@ifc-lite/source-dalux` sets `eagerFileSweep: true` to keep its existing full-sweep behaviour unchanged. `@ifc-lite/source-fixture`'s `createFixtureSourceProvider` gains a matching `eagerFileSweep` option (default `false`) for testing either path.

No behaviour change for Dalux, the only provider in production. A future provider that leaves the capability off gets incremental file paging instead of an eager, possibly-failing sweep.
