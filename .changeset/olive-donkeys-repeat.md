---
"@ifc-lite/lists": patch
---

Fix the Wall Schedule preset asking for a quantity that does not exist in IFC. `Qto_WallBaseQuantities` has no `NetArea` member in any schema version — the wall side-area quantity is `NetSideArea` — so the preset's last column resolved against nothing and rendered permanently empty. Closes #1873.
