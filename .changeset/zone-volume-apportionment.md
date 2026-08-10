---
"@ifc-lite/lists": minor
---

Add `zone` column/condition modes that report how much VOLUME of an element sits in each zone (`Volume (mesh)` and `Volume breakdown (mesh)`), backed by a new optional `ListDataProvider.getZoneVolumeShares` hook. The numeric mode is tagged as a volume quantity so the shared per-column unit resolver converts and labels it like any declared `NetVolume`. Providers built before this simply have no volume data and the columns read `null`.
