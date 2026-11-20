---
"@ifc-lite/renderer": patch
---

Moving or rotating a model no longer drops the hide/isolate, selection and appearance-suppression flags or the colour override and X-Ray fade of its GPU-instanced occurrences. Each per-occurrence write now also updates the CPU instance record that a model move re-uploads in full.
