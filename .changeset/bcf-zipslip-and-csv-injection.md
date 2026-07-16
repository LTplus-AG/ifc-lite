---
"@ifc-lite/bcf": patch
"@ifc-lite/lists": patch
---

Harden BCF archive I/O and the CSV formula-injection guard.

BCF writer now sanitizes a topic GUID before using it as a zip folder name, so a GUID parsed from untrusted markup (`../../evil`) can no longer traverse outside the archive root on a read-modify-save (zip-slip). BCF reader now caps the compressed input size, total entry count, and declared expanded size before decompressing, rejecting zip-bomb archives instead of OOMing.

The lists CSV export formula-injection guard no longer quotes genuine numeric cells: `-0.35` and `+1` export unquoted (summable in Excel), while real injection vectors (`=`, `@`, tab/CR, and a leading `-`/`+` that is not a plain number such as `-cmd` or `-1+cmd`) are still prefixed with an apostrophe.
