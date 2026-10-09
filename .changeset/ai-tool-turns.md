---
"@ifc-lite/ai": minor
---

`runToolTurn`: one provider-neutral tool-calling model turn with the same root budget, deadline, cancellation and usage receipt as `runModelRequest`. The new `ToolSpec`, `ContentBlock`, `ToolTurnMessage` and `ToolTurnTransport` types are the contract provider adapters implement; the receipt records the model that actually served the turn.
