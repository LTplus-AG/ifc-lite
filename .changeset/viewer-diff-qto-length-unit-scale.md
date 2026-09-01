---
'@ifc-lite/viewer': patch
---

Fix the compare panel reporting every quantified element as modified when the two files simply declare different project length units. Qto_ Length/Area/Volume quantities are now compared in base SI rather than the raw author-unit value.
