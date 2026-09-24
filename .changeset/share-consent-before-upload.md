---
"@ifc-lite/viewer": patch
---

Opening the Share dialog no longer uploads the model. With one model the dialog used to create the collaboration room, and upload the model into it, the moment it opened. It now waits for an explicit **Create link** at every model count, the same step multi-model shares already had. That step now says the model data will be uploaded to the collaboration server. New links also default to **View** access instead of **Edit**, so sharing grants the least privilege unless you pick more (#5599).
