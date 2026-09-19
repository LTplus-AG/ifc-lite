---
"@ifc-lite/parser": major
---

Release `@ifc-lite/parser` as a new major because its public store implementations now satisfy the source-breaking `@ifc-lite/data` `EntityTable` contract introduced for absent-versus-empty entity names. Consumers implementing or structurally typing the previous table contract must not receive that change through a compatible parser range.
