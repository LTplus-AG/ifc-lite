---
"@ifc-lite/viewer": minor
---

A paired agent can open models with the new `viewer_open_model` tool: a bundled sample or an `https` URL, replacing or added to the loaded models. It waits for the load and returns each `model_id`. It needs the commands-and-edits grant and refuses to replace models with unexported edits. Agent operation and command search now ranks natural-language queries, input errors describe the expected shape, `model_list` text includes model ids, and the connection panel folds repeated read calls and names models. When opening a single .ifc or .ifczip, preflight refuses common error responses and non-STEP text routed to the IFC parser before resetting the scene, so the models already open stay open.
