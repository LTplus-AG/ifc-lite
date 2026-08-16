# @ifc-lite/source-dalux

## 0.2.3

### Patch Changes

- [#2630](https://github.com/LTplus-AG/ifc-lite/pull/2630) [`9d6daac`](https://github.com/LTplus-AG/ifc-lite/commit/9d6daac8133a6f41e3d400aa597f73029fde4376) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Gate the eager file-listing sweep on a new provider capability, `eagerFileSweep` ([#2613](https://github.com/LTplus-AG/ifc-lite/issues/2613)).

  `fetchAllFilePages` in the viewer's source browser used to drain every page of a container's `listFiles` up front, unconditionally, for any `FileSourceProvider` — capped at 100,000 items / 5,000 pages, throwing above that. That was fine while Dalux was the only provider (its own UI has no per-folder "load more files" concept, so a full sweep matches its UX), but a provider with a real per-folder file endpoint would have blocked a folder's first render on a full drain, and risked hitting the cap outright on a large folder.

  `ProviderCapabilities` gains `eagerFileSweep?: boolean`, defaulting to off. Off means the viewer pages a container's files incrementally — one page loads eagerly, further pages via a new `loadMoreFiles` (mirroring the existing `loadMoreFolders`) — the same way folder listings already work. `@ifc-lite/source-dalux` sets `eagerFileSweep: true` to keep its existing full-sweep behaviour unchanged. `@ifc-lite/source-fixture`'s `createFixtureSourceProvider` gains a matching `eagerFileSweep` option (default `false`) for testing either path.

  No behaviour change for Dalux, the only provider in production. A future provider that leaves the capability off gets incremental file paging instead of an eager, possibly-failing sweep.

- Updated dependencies [[`9d6daac`](https://github.com/LTplus-AG/ifc-lite/commit/9d6daac8133a6f41e3d400aa597f73029fde4376)]:
  - @ifc-lite/plugin-api@0.3.0

## 0.2.2

### Patch Changes

- [#2253](https://github.com/LTplus-AG/ifc-lite/pull/2253) [`9e6020d`](https://github.com/LTplus-AG/ifc-lite/commit/9e6020d116b2669cfb934cfa40b9f4f74d87fad5) Thanks [@bruadam](https://github.com/bruadam)! - Fix `listProjects` (and any other single-page Dalux listing) failing with `Dalux pagination truncated at <endpoint>: N item(s) remain but the server sent no nextPage link` even when the response was a genuinely complete, final page.

  `fetchPage` previously treated `metadata.totalRemainingItems > 0` combined with an absent `nextPage` link as proof the listing was truncated, and threw `DaluxPaginationError`. In practice Dalux's `/5.1/projects` (and likely other endpoints) can report a positive `totalRemainingItems` on the page that legitimately has no more pages — e.g. a project count of 1 — so that combination isn't actually anomalous. An unofficial third-party reference client (`bruadam/dalux-build`, `javascript/src/utils/pagination.js`) agrees: it never uses `totalRemainingItems` to decide whether to keep paging, only to log progress, and stops purely on the absence of a `nextPage` link.

  `fetchPage` now does the same — a page with no `nextPage` link is always the last page, regardless of `totalRemainingItems`.

  Also fix `listFiles` (and any other paged listing) failing with `Dalux pagination stuck at <endpoint>: server returned the same bookmark again`. `fetchPage` previously treated any bookmark that echoes the one just requested as a broken response. Observed live on `/6.1/projects/.../file_areas/.../files`: Dalux can keep re-sending the same bookmark on what is genuinely the final page (a 0-item page) instead of ever omitting the `nextPage` link, matching how the original Dalux Box integration ([#1761](https://github.com/LTplus-AG/ifc-lite/issues/1761)) and an unofficial third-party reference client (`bruadam/dalux-build`) both treat it.

  `fetchPage` now only treats an echoed bookmark as a clean end of listing when the repeating page is actually empty — Dalux's pagination isn't reliable enough to trust that every echo means "done". An echo that still carries items now throws instead, since that means the server has stopped making forward progress while real data remains unread, and reporting that as a clean, short result would silently drop it. `fetchAllPages`' separate, longer-cycle check (a bookmark resurfacing several pages later, not just on the immediately preceding one) still always throws, regardless of item count — that shape means content already read is about to be handed back again rather than new content ever arriving. A `nextPage` link with no bookmark at all is still treated as a broken response too, since that shape can't be reconciled with "the listing is done".

## 0.2.1

### Patch Changes

- [#2505](https://github.com/LTplus-AG/ifc-lite/pull/2505) [`6c5e0a5`](https://github.com/LTplus-AG/ifc-lite/commit/6c5e0a5d595a032a88725d6091f8fe6751ea5b43) Thanks [@louistrue](https://github.com/louistrue)! - Run the shared `FileSourceProvider` conformance suite against `DaluxBuildProvider`, over a mock of the Dalux Build REST API (`@ifc-lite/source-fixture/conformance`, added as a dev dependency). No runtime code changes: this adds the test wiring the kit was written for but never had.

  Three of the kit's assertions had to be corrected first, because each failed a provider that behaves exactly as the plugin contract specifies. `ListOptions.limit` is documented as a hint, and Dalux's bookmark pagination takes no page-size argument, so the "a real page boundary forces cursor-following to work" check — which forced boundaries by passing `limit` and then counting requests — failed `listProjects`, `listContainers` and `listFiles` on a correct provider. And `RevisionWatchResult.cursor` is optional, documented as what providers with a delta endpoint return, yet the suite required one from every provider declaring `changeDetection`; Dalux polls and correctly returns none. The third is the mirror of that one: the suite asserted unconditionally that `watchRevisions` reports no events for an empty ref list, but the contract tells a delta-backed provider to ignore `refs` and read its cursor, so that assertion rejected a correct change-feed provider and is now scoped to polling providers.

## 0.2.0

### Minor Changes

- [#2023](https://github.com/LTplus-AG/ifc-lite/pull/2023) [`f86436b`](https://github.com/LTplus-AG/ifc-lite/commit/f86436bb464349c7ae653c275cdc13c6c4b1ca8f) Thanks [@louistrue](https://github.com/louistrue)! - First release of `@ifc-lite/source-dalux`, a Dalux Build (Box) file-source provider on the v2 plugin contract (`manifest.api: '^2.0.0'`, declared `capabilities`/`auth`/`permissions.relay`, `Page<T>`-returning listing methods, `SourceFileRef`-based `download`, `watchRevisions`). Closes [#1663](https://github.com/LTplus-AG/ifc-lite/issues/1663).

  Dalux Build's API sends no CORS headers, so browser requests go through the same-origin relay at `/api/dalux` (`vercel.json` rewrite in production, vite proxy in dev), declared in the manifest and validated by the host against its configured routes. The relay refuses upstream redirects that leave the declared host, so a redirect cannot carry the API key off-origin, and it does not forward the key to any other host.

  Talks to the Dalux HTTP API directly rather than through the third-party `dalux-build-api` client.

  `minor`, not `major`, despite superseding an earlier unreleased shape: the package has never been published, so there are no consumers to break, and this repo bumps breaking changes on `0.x` packages as `minor`.

### Patch Changes

- Updated dependencies [[`c8f771c`](https://github.com/LTplus-AG/ifc-lite/commit/c8f771ca15754cf314288f6797ac05a674a1e6b1), [`c8f771c`](https://github.com/LTplus-AG/ifc-lite/commit/c8f771ca15754cf314288f6797ac05a674a1e6b1)]:
  - @ifc-lite/plugin-api@0.2.0
