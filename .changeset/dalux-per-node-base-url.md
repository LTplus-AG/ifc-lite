---
'@ifc-lite/source-dalux': minor
---

Let a Dalux user reach their own node. Dalux assigns each customer a node and
prints its base URL beside the API key, but the base URL was fixed at node1, so
every customer on node2 or above could not use Dalux Box at all. A new optional
"API base URL" preference accepts the URL Dalux shows them.

Only the node NAME is taken from that URL, and the relay assembles the origin
from an anchored allowlist. A caller-supplied base URL is never forwarded: the
relay attaches the caller's `X-API-KEY`, so accepting one would turn it into an
open proxy that leaks that key to any host the caller names.
