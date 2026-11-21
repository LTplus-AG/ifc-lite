---
"@ifc-lite/mutations": patch
---

Record unset positional IFC attributes as STEP null values when edited through the viewer or CLI SDK, so the clear survives mutation history serialization and replay.
