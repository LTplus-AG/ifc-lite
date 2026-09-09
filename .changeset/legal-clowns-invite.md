---
"@ifc-lite/export": patch
---

Preserve inverse texture maps and their UV resources when exporting a visible or isolated subset. Resolve maps through their effective MappedTo geometry so shared images cannot restore hidden surfaces and pending retargets/deletions are respected.
