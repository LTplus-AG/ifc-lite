# @ifc-lite/source-fixture

## 0.3.0

### Minor Changes

- [#6460](https://github.com/LTplus-AG/ifc-lite/pull/6460) [`9bbe599`](https://github.com/LTplus-AG/ifc-lite/commit/9bbe599a1d256bff7648584517eb258bbe42cb65) Thanks [@louistrue](https://github.com/louistrue)! - Report download progress from the Dropbox, OneDrive/SharePoint and Dalux providers. `@ifc-lite/plugin-api` gains `readWithProgress(response, onProgress, fallbackTotal)`, which streams a response body and calls `DownloadOptions.onProgress` about ten times a second, starting at `(0, total)` and ending at `(byteLength, byteLength)`. When `Content-Length` is missing, the total falls back to the file's listed size. The `@ifc-lite/source-fixture` conformance suite now checks that a provider's download progress only increases and ends at the byte length.

### Patch Changes

- Updated dependencies [[`9bbe599`](https://github.com/LTplus-AG/ifc-lite/commit/9bbe599a1d256bff7648584517eb258bbe42cb65)]:
  - @ifc-lite/plugin-api@0.4.0

## 0.2.0

### Minor Changes

- [#2630](https://github.com/LTplus-AG/ifc-lite/pull/2630) [`9d6daac`](https://github.com/LTplus-AG/ifc-lite/commit/9d6daac8133a6f41e3d400aa597f73029fde4376) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Gate the eager file-listing sweep on a new provider capability, `eagerFileSweep` ([#2613](https://github.com/LTplus-AG/ifc-lite/issues/2613)).

  `fetchAllFilePages` in the viewer's source browser used to drain every page of a container's `listFiles` up front, unconditionally, for any `FileSourceProvider` — capped at 100,000 items / 5,000 pages, throwing above that. That was fine while Dalux was the only provider (its own UI has no per-folder "load more files" concept, so a full sweep matches its UX), but a provider with a real per-folder file endpoint would have blocked a folder's first render on a full drain, and risked hitting the cap outright on a large folder.

  `ProviderCapabilities` gains `eagerFileSweep?: boolean`, defaulting to off. Off means the viewer pages a container's files incrementally — one page loads eagerly, further pages via a new `loadMoreFiles` (mirroring the existing `loadMoreFolders`) — the same way folder listings already work. `@ifc-lite/source-dalux` sets `eagerFileSweep: true` to keep its existing full-sweep behaviour unchanged. `@ifc-lite/source-fixture`'s `createFixtureSourceProvider` gains a matching `eagerFileSweep` option (default `false`) for testing either path.

  No behaviour change for Dalux, the only provider in production. A future provider that leaves the capability off gets incremental file paging instead of an eager, possibly-failing sweep.

### Patch Changes

- Updated dependencies [[`9d6daac`](https://github.com/LTplus-AG/ifc-lite/commit/9d6daac8133a6f41e3d400aa597f73029fde4376)]:
  - @ifc-lite/plugin-api@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`c8f771c`](https://github.com/LTplus-AG/ifc-lite/commit/c8f771ca15754cf314288f6797ac05a674a1e6b1), [`c8f771c`](https://github.com/LTplus-AG/ifc-lite/commit/c8f771ca15754cf314288f6797ac05a674a1e6b1)]:
  - @ifc-lite/plugin-api@0.2.0
