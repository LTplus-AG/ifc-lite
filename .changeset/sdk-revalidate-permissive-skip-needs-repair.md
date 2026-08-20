---
"@ifc-lite/extensions": patch
---

Fix `revalidateAgainstSdk` silently treating an unverifiable extension as fine after an SDK bump.

An extension whose declared `engines.ifcLiteSdk` range is too loose to evaluate (e.g. a wildcard like `2.x`) gets `compatibility.status: 'permissive'` — the range comparator's own docs describe this as "worth a re-test, even if the range technically passes." When such an extension has no declared tests (or its bundle bytes aren't available), the test run comes back `outcome: 'skipped'` — nothing actually confirmed it still works. `needsRepair` only included skipped rows whose status was `'outdated'`, so a permissive, self-unverifiable extension never surfaced in the repair queue after a major SDK bump. Since `'skipped'` can only occur for `'outdated'` or `'permissive'` rows (the `'compatible'` branch always resolves to `'pass'` without touching the test runner), `needsRepair` now includes every skipped row.
