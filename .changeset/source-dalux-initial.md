---
"@ifc-lite/source-dalux": minor
---

First release of `@ifc-lite/source-dalux`, a Dalux Build (Box) file-source provider on the v2 plugin contract (`manifest.api: '^2.0.0'`, declared `capabilities`/`auth`/`permissions.relay`, `Page<T>`-returning listing methods, `SourceFileRef`-based `download`, `watchRevisions`). Closes #1663.

Dalux Build's API sends no CORS headers, so browser requests go through the same-origin relay at `/api/dalux` (`vercel.json` rewrite in production, vite proxy in dev), declared in the manifest and validated by the host against its configured routes. The relay refuses upstream redirects that leave the declared host, so a redirect cannot carry the API key off-origin, and it does not forward the key to any other host.

Talks to the Dalux HTTP API directly rather than through the third-party `dalux-build-api` client.

`minor`, not `major`, despite superseding an earlier unreleased shape: the package has never been published, so there are no consumers to break, and this repo bumps breaking changes on `0.x` packages as `minor`.
