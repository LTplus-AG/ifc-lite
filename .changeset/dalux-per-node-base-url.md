---
'@ifc-lite/source-dalux': minor
---

Let a Dalux user reach their own node. Dalux assigns each customer a node and
prints its base URL beside the API key, but the base URL was fixed at node1, so
every customer on node2 or above could not use Dalux Box at all. A new optional
"API base URL" preference accepts the URL Dalux shows them.

Only the node NAME is taken from that URL, and the relay assembles the origin
from an anchored allowlist. A caller-supplied base URL is never forwarded,
because `/api/dalux` is unauthenticated and publicly reachable: any host the
relay can be aimed at becomes reachable by anyone through our egress IPs.
Building the origin ourselves bounds that to Dalux.
