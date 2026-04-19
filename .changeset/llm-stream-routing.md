---
"@ifc-lite/viewer": patch
---

Extract LLM stream routing into a shared helper and handle Codex's truncation marker so long responses are no longer cut off mid-sentence. BYOK guard logic moves into its own module with unit tests covering the direct-stream path.
