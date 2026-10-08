---
"@ifc-lite/ai": minor
"@ifc-lite/flow-nodes": minor
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
---

Retain dispatched request grants, deadlines, safe finish reasons, producer-declared prompt versions and versioned logical-input/output-text SHA256 digests in canonical generation receipts. Flow hosts forward native producer versions without persisting raw prompts, responses, credentials or endpoints.

Bind receipt model/route to the actual dispatched identities. Native JSON producers explicitly prepare one parsed snapshot for both dispatch and logical digest; generic opaque custom transports keep unknown input metadata without reflection or changed sent-input semantics.
