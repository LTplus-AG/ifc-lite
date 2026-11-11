---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
---

Add structural surface member, curve connection and surface connection builders with schema-aware boundary conditions and planar topology. On `bim.store` they are optional backend methods, so existing custom backends still type-check; calling one on a backend without it throws "not available on this backend".
