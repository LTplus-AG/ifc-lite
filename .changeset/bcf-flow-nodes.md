---
"@ifc-lite/flow-nodes": minor
---

Add BCF API flow nodes: `bcf.listTopics` (topics as a table plus the raw list, with OData filter/orderby/top), `bcf.createTopic` (from params or one topic per table row) and `bcf.addComment`. They use `@ifc-lite/bcf-api`'s client over the gated `coreNetworkRequest` transport, so every request needs a declared `network.fetch:<host>` grant, and the bearer token can come from a `{{secret:NAME}}` reference. The nodes are never memoised.
