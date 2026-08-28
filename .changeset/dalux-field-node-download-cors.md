---
'@ifc-lite/source-dalux': patch
---

Fix "Failed to fetch" downloading a Dalux Box file for an account on a node other than node1.

`download()` falls back to a `downloadLink`/revision-content URL Dalux hands back when the file carries no known revision id. For an account on, say, node2, that URL points straight at `node2.field.dalux.com` — not the canonical `node1.field.dalux.com` origin every request in this provider is otherwise built against. The client only ever routed URLs matching that canonical origin through the app's same-origin relay, so this one went out as a direct cross-origin fetch to Dalux, which sends no CORS headers on any node, and the browser blocked it.

`getBinary` now recognises a Dalux field-node-shaped URL that lands on a *different* node than `baseUrl` and reroutes it back onto the canonical origin with that node stamped as the relay's `daluxNode` parameter, the same way an explicit node preference is already stamped onto same-origin requests. A genuinely different host (an opaque signed CDN link) is still left byte-for-byte untouched.
