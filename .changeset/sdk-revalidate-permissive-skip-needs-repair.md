---
"@ifc-lite/extensions": minor
---

Fix `revalidateAgainstSdk` silently treating an unverifiable extension as fine after an SDK bump.

An extension whose declared `engines.ifcLiteSdk` range is too loose to evaluate (e.g. a wildcard like `2.x`) gets `compatibility.status: 'permissive'` — the range comparator's own docs describe this as "worth a re-test, even if the range technically passes." When such an extension has no declared tests (or its bundle bytes aren't available), the test run comes back `outcome: 'skipped'` — nothing actually confirmed it still works. `needsRepair` only included skipped rows whose status was `'outdated'`, so a permissive, self-unverifiable extension never surfaced in the repair queue after a major SDK bump. Since `'skipped'` can only occur for `'outdated'` or `'permissive'` rows (the `'compatible'` branch always resolves to `'pass'` without touching the test runner), `needsRepair` now includes every skipped row.

The rule now lives in one exported function, `needsSdkRepair`. The viewer's repair panel carried a second copy of the predicate to decide which rows get a Repair button, so widening only the queue side made the header ("N need fixing") count permissive, skipped extensions whose rows offered no way to fix them. Both sides call the shared function, and a rendering test pins the invariant the two copies were supposed to preserve: the header count equals the number of rows with a Repair button.
