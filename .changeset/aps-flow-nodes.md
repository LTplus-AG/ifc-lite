---
"@ifc-lite/flow-nodes": minor
---

Add Autodesk Platform Services receive nodes for flow graphs (#5634): `aps.token` mints a 2-legged client-credentials token (or wraps a provided 3-legged one) as an opaque handle that is never output, logged or serialised, and `aps.modelProperties` reads Model Derivative metadata and properties of a translated model (derivative URN or Docs/ACC version id) into a table keyed by `externalId`, with `category`, `IfcGUID` and every property as a `Group.Property` column, ready for `table.joinByKey`. All requests go through the gated `coreNetworkRequest` (`network.fetch:developer.api.autodesk.com`), and APS's `202` "still processing" answer is retried a bounded number of times.
