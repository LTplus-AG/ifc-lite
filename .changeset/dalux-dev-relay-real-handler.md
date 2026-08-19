---
'@ifc-lite/source-dalux': patch
---

Fix the Dalux node selection in local development, which was inert. The dev
proxy was given a `router` callback to pick the upstream per request, but Vite
has no such option: it uses `http-proxy-3`, while `router` belongs to
`http-proxy-middleware`. The callback was silently ignored, so a developer on a
non-default node still reached node1.

Dev now serves `/api/dalux` with the same relay handler production uses, rather
than a second proxy configuration that can drift from it.
