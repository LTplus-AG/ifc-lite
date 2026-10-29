---
"@ifc-lite/export": patch
---

Security: a `{ typed: { type, value } }` attribute value whose type name is not an IFC identifier is now refused instead of being written bare into the STEP output, where it could break out of the attribute list and inject records (GHSA-hw42-92fr-x9vc).
