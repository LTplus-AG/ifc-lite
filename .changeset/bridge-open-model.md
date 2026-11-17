---
"@ifc-lite/viewer": minor
---

A paired agent can open models with the new `viewer_open_model` tool: a bundled sample or an `https` URL, replacing or added to the loaded models. It waits for the load and returns each `model_id`. It needs the commands-and-edits grant and refuses to replace models with unexported edits. Agent operation and command search now ranks natural-language queries, input errors describe the expected shape, `model_list` text includes model ids, and the connection panel folds repeated read calls and names models. Opening a .ifc or .ifczip whose content is neither STEP nor a ZIP (an error page saved or served as a model) is now refused before the scene resets, so the models already open stay open.
