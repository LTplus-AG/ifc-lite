---
"@ifc-lite/bcf": patch
"@ifc-lite/lists": patch
---

Harden BCF archive I/O and the CSV formula-injection guard.

BCF writer now sanitizes a topic GUID before using it as a zip folder name, so a GUID parsed from untrusted markup (`../../evil`) can no longer traverse outside the archive root on a read-modify-save (zip-slip). Sanitized names that collide (`a?b` and `a:b` both map to `a_b`) are disambiguated with a hash of the original GUID plus a counter backstop, so no topic silently overwrites another. BCF reader now caps the compressed input size, the raw zip record count (scanned from the buffer, so duplicate-pathname floods that JSZip dedupes to one visible entry are still counted), and the declared expanded size; because declared sizes are attacker-controlled, the expansion cap is additionally enforced on the ACTUAL decompressed bytes as entries stream out, aborting mid-entry. Entries declaring invalid (negative-reading) sizes are rejected outright.

The lists CSV export formula-injection guard no longer quotes genuine numeric cells: `-0.35` and `+1` export unquoted (summable in Excel), while real injection vectors (`=`, `@`, tab/CR, and a leading `-`/`+` that is not a plain number such as `-cmd` or `-1+cmd`) are still prefixed with an apostrophe.
