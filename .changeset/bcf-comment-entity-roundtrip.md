---
"@ifc-lite/bcf": patch
---

Fix BCF round-trip data loss. On read, XML entities in titles, descriptions, comments, and labels are now unescaped, so `&`, `<`, `>`, `"`, `'` come back exactly as written instead of as literal entities. The comment parser no longer truncates every comment to an empty string: the outer `<Comment Guid="...">` wrapper shares its tag name with its nested `<Comment>` text field, so the parser now slices each wrapper's span up to the next wrapper (or end of markup) and takes the last `</Comment>` as its real close. That is robust across BCF 2.1 and 3.0 (where comments sit inside a `<Comments>` container) and tolerates unknown vendor elements, so no comment is silently dropped. On write, `BimSnippet` (when it carries the schema-required `ReferenceSchema`) and `DocumentReference` are now emitted; they were parsed and typed but never written, so they were silently dropped on every export.
