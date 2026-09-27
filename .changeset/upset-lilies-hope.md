---
"@ifc-lite/lens": major
"@ifc-lite/sdk": major
---

Remove the retired `LensCriteria`, `LensOperator`, and v1 operator/compound constants from the published Lens API, and remove the SDK's `LensCriteria` re-export. `LensRule` now carries shared `FilterGroup` rules instead of a `criteria` field. Consumers creating manual rules should supply `groups`; saved v1 viewer JSON is still migrated on import, with unreadable conditions shown for explicit replacement.
