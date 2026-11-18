---
"@ifc-lite/parser": minor
"@ifc-lite/cli": minor
"@ifc-lite/viewer": patch
---

Report which linked curve members the structural movement and axis-drift rules compared (#10640). `structuralConsistencyReport(store, options)` returns the issues plus `coverage`: the linked curve member count and each skipped member with its reason per rule (`edge-unreadable`, `no-derivation-record`, `element-without-axis`). `ifc-lite validate` reports skipped members as `structural-unchecked-member`, in text and JSON. The viewer's analysis model check lists them from the same report, with the reason on each row.
