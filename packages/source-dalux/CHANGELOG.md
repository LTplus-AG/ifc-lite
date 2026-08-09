# @ifc-lite/source-dalux

## 0.2.0

### Minor Changes

- [#2023](https://github.com/LTplus-AG/ifc-lite/pull/2023) [`f86436b`](https://github.com/LTplus-AG/ifc-lite/commit/f86436bb464349c7ae653c275cdc13c6c4b1ca8f) Thanks [@louistrue](https://github.com/louistrue)! - First release of `@ifc-lite/source-dalux`, a Dalux Build (Box) file-source provider on the v2 plugin contract (`manifest.api: '^2.0.0'`, declared `capabilities`/`auth`/`permissions.relay`, `Page<T>`-returning listing methods, `SourceFileRef`-based `download`, `watchRevisions`). Closes [#1663](https://github.com/LTplus-AG/ifc-lite/issues/1663).

  Dalux Build's API sends no CORS headers, so browser requests go through the same-origin relay at `/api/dalux` (`vercel.json` rewrite in production, vite proxy in dev), declared in the manifest and validated by the host against its configured routes. The relay refuses upstream redirects that leave the declared host, so a redirect cannot carry the API key off-origin, and it does not forward the key to any other host.

  Talks to the Dalux HTTP API directly rather than through the third-party `dalux-build-api` client.

  `minor`, not `major`, despite superseding an earlier unreleased shape: the package has never been published, so there are no consumers to break, and this repo bumps breaking changes on `0.x` packages as `minor`.

### Patch Changes

- Updated dependencies [[`c8f771c`](https://github.com/LTplus-AG/ifc-lite/commit/c8f771ca15754cf314288f6797ac05a674a1e6b1), [`c8f771c`](https://github.com/LTplus-AG/ifc-lite/commit/c8f771ca15754cf314288f6797ac05a674a1e6b1)]:
  - @ifc-lite/plugin-api@0.2.0
