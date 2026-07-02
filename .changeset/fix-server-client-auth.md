---
"@ifc-lite/server-client": patch
---

fix(server-client): send the auth token on data-model and symbolic fetches

`fetchDataModel` and `fetchSymbolic` were the only requests that omitted
`authHeaders()`, so against a server started with `IFC_SERVER_API_TOKEN` the
geometry parse succeeded but the follow-up data-model and symbolic fetches got
401 and silently returned null — the model loaded with no properties and no
annotations. Both now send the `Authorization` header like every other request.

Also: the streaming parse cache-check now includes the parse query string
(`parseQuery(options)`), matching the non-streaming path, so a cached result for
a different tessellation quality is no longer returned as a hit.
