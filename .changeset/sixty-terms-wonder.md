---
"@ifc-lite/ai": minor
"@ifc-lite/flow-nodes": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

Carry native Flow AI response schemas through shared requests and host transports, recording whether the request used JSON Schema or text. Preserve native evidence checks and review checkpoints; compatible headless providers can explicitly enable schema requests.

Add the typed unsupported-schema refusal for known host limitations. The viewer checks Anthropic grammar limits before spending the request budget, and native Flow nodes report the limitation without inventing sent evidence.
