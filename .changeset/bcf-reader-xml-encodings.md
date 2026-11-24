---
"@ifc-lite/bcf": patch
---

The BCF reader no longer drops topics from archives whose XML is not UTF-8. It decodes every entry by byte-order mark and first-byte shape (UTF-16 with or without a BOM), so a UTF-16 `markup.bcf` keeps its topic and a UTF-16 `bcf.version` no longer rejects the archive, and it reads an ISO-8859-1 or windows-1252 entry that declares that encoding instead of replacing accented characters with U+FFFD. A `utf-16` declaration over UTF-8 bytes is still read as UTF-8.
