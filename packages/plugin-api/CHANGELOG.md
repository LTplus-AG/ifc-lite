# @ifc-lite/plugin-api

## 0.3.0

### Minor Changes

- [#2630](https://github.com/LTplus-AG/ifc-lite/pull/2630) [`9d6daac`](https://github.com/LTplus-AG/ifc-lite/commit/9d6daac8133a6f41e3d400aa597f73029fde4376) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Gate the eager file-listing sweep on a new provider capability, `eagerFileSweep` ([#2613](https://github.com/LTplus-AG/ifc-lite/issues/2613)).

  `fetchAllFilePages` in the viewer's source browser used to drain every page of a container's `listFiles` up front, unconditionally, for any `FileSourceProvider` — capped at 100,000 items / 5,000 pages, throwing above that. That was fine while Dalux was the only provider (its own UI has no per-folder "load more files" concept, so a full sweep matches its UX), but a provider with a real per-folder file endpoint would have blocked a folder's first render on a full drain, and risked hitting the cap outright on a large folder.

  `ProviderCapabilities` gains `eagerFileSweep?: boolean`, defaulting to off. Off means the viewer pages a container's files incrementally — one page loads eagerly, further pages via a new `loadMoreFiles` (mirroring the existing `loadMoreFolders`) — the same way folder listings already work. `@ifc-lite/source-dalux` sets `eagerFileSweep: true` to keep its existing full-sweep behaviour unchanged. `@ifc-lite/source-fixture`'s `createFixtureSourceProvider` gains a matching `eagerFileSweep` option (default `false`) for testing either path.

  No behaviour change for Dalux, the only provider in production. A future provider that leaves the capability off gets incremental file paging instead of an eager, possibly-failing sweep.

## 0.2.0

### Minor Changes

- [#1976](https://github.com/LTplus-AG/ifc-lite/pull/1976) [`c8f771c`](https://github.com/LTplus-AG/ifc-lite/commit/c8f771ca15754cf314288f6797ac05a674a1e6b1) Thanks [@louistrue](https://github.com/louistrue)! - Adds the cloud source plugin architecture. `@ifc-lite/plugin-api` is a dependency-free type surface (`FileSourceProvider`, `PluginContext`, `PluginManifest`, and related types) that third-party file-source plugins implement against, so a provider can be written and versioned without depending on the viewer.

  Architecture originally by @bruadam in [#1761](https://github.com/LTplus-AG/ifc-lite/issues/1761), where it shipped alongside a Dalux Build provider. This change lands the contract, the host and the UI on their own; the providers follow in their own PRs (`@ifc-lite/source-dalux`, then `@ifc-lite/source-msgraph`), so each gets a reviewable diff instead of one 127-file drop.

- [#1976](https://github.com/LTplus-AG/ifc-lite/pull/1976) [`c8f771c`](https://github.com/LTplus-AG/ifc-lite/commit/c8f771ca15754cf314288f6797ac05a674a1e6b1) Thanks [@louistrue](https://github.com/louistrue)! - Reshapes the file-source plugin contract to v2 (`PLUGIN_API_VERSION = '2.0.0'`),
  drawn against two deliberately dissimilar providers rather than one, so that
  provider-specific limitations are declared instead of assumed.

  - `SourceAuth` + `manifest.auth` for providers using interactive sign-in
    (OAuth), alongside the existing preference-based credentials.
  - `manifest.capabilities` replaces implicit behaviour: `containerListing`
    (`direct-children` vs `flat-subtree`), `listFilesIsRecursive`,
    `revisionHistory`, `changeDetection`, `search`, and
    `projectsAreDiscoverableOnly` for stores that cannot enumerate projects.
  - All listing methods return `Page<T>` with an opaque `cursor`; `ListOptions`
    adds `AbortSignal` support throughout.
  - `download` takes a `SourceFileRef` (project + container + file + optional
    revision) instead of a bare file id, removing the need for providers to keep
    an id-to-location cache and crawl on a miss.
  - `ctx.fetchPublic` for pre-signed, credential-free URLs: the host strips every
    header but `Accept` and `Range`, so a provider cannot send a credential to a
    host outside its authenticated allowlist. `permissions.publicNetwork` scopes
    it separately from `permissions.network`.
  - `permissions.relay` declares a same-origin relay for APIs without CORS; hosts
    validate it against the routes they actually serve and refuse registration
    otherwise.
  - `checkRevisions` becomes `watchRevisions`, cursor-based so providers with a
    delta endpoint can poll cheaply; `SourceRevision.version: number` becomes an
    opaque `id: string` plus `label` (SharePoint version labels are `"1.0"`).
  - Adds `satisfiesCaretRange` and `matchesGlob` so host and providers cannot
    disagree about range semantics or what `*.ifc` means.
