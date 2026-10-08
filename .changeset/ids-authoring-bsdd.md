---
"@ifc-lite/ids-authoring": minor
---

bSDD for IDS authoring: a `BsddSource` port with an HTTP client for the public bSDD API (`createHttpBsddSource`), a framework-free picker view model (filters, debounced search, class cards), the `bulk.fromBsddClass` compound op (class → classification and/or entity facets and property requirements) with the bSDD property → requirement mapping table (`mapBsddProperty`), a dictionary → IDS generator with inheritance, scope options and a dry-run preview, URI health (`checkUriHealth`, a 24 h cache, rate-limited) feeding the new lint rules IDSL-BSDD-001…003 and the gate rule GATE-BSDD-001, and an offline cache (`createCachedBsddSource`, IndexedDB store). New primitive op `facet.setUri`; facet drafts carry `uri`; new gate codes GATE-STR-009 and GATE-VAL-009. `GateResult.ok` is true when only non-blocking (`severity: 'warning'`) issues remain.
