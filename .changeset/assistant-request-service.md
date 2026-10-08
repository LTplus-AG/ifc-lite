---
"@ifc-lite/viewer": minor
---

Assistant requests now run through a shared request service with typed outcomes, a per-conversation root budget (16 requests, 40,960 output tokens per evidence snapshot), session-only usage receipts showing provider-reported token counts under each answer, and the remaining free proxy requests in the composer footer. OpenAI keys now request usage in the stream.
