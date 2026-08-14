# @ifc-lite/plugin-api

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
