# @ifc-lite/source-dalux

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
