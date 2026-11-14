---
"@ifc-lite/cache": patch
"@ifc-lite/data": patch
---

Retain parser relationship coverage in worker and disk-cache stores so current type quantities do not rebuild a model inventory after cache hydration. Cache format v28 refreshes older viewer entries that lack this metadata.
