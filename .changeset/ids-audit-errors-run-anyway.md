---
"@ifc-lite/viewer": patch
---

IDS panel: audit errors no longer block validation. A document the strict parser accepted can be validated against the model even when the audit flags non-standard property names or dataTypes inside standard property sets (#5123); the issues stay listed next to the Run button with a note that the check runs regardless. Documents the parser rejects still cannot be validated.
