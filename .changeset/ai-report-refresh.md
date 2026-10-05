---
"@ifc-lite/viewer": minor
---

A saved AI report can refresh its evidence from **Documents**. It refuses a native result that predates a model edit and warns when the loaded models differ from the ones the report was drafted against. It re-finds each cited row, including citations in the narrative and in claim text, by its native identity, tells rows outside a sampled capture apart from removed ones, re-checks every claim, flags changed and missing values in the document, and regenerates untouched AI text. Human edits are kept unless the reviewer replaces them block by block, and deleted blocks stay deleted. The block list marks AI-generated and edited AI text. Duplicated blocks and documents built from an AI report as a template no longer carry its AI provenance or old evidence.
