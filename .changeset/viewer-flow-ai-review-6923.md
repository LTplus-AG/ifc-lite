---
"@ifc-lite/viewer": minor
---

Flow AI nodes in the viewer (#6923). The Flow panel offers `ai.classify`, `ai.summarize` and `ai.extract` (loaded with the panel) and a "10 · AI wall roles (reviewed)" example. AI nodes use the model chosen for the Assistant through the shared request service, with one root budget per run. A run that reaches an AI proposal pauses: a review card shows every row of the proposal and its coverage, and only **Approve and resume** continues the run from exactly that proposal, restoring completed nodes without running them and sending no new model request; **Reject** ends it. Checkpoints persist in the browser, are consumed once across tabs, and are refused after any model, edit or graph change. Feature catalogues can now load their English strings with their chunk.
