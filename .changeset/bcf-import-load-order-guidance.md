---
"@ifc-lite/viewer": patch
---

Tell the user to load the model first when a BCF is imported with none loaded, instead of silently importing topics whose viewpoints and component references can never resolve. Also explain, instead of silently doing nothing, when a `.bcf`/`.bcfzip` file is dropped onto the main viewport — it names a model, not a BCF archive; the BCF panel's Import button is the way to load one.
