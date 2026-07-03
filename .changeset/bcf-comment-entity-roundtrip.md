---
"@ifc-lite/bcf": patch
---

Fix BCF round-trip data loss. On read, XML entities in titles, descriptions, comments, and labels are now unescaped, so `&`, `<`, `>`, `"`, `'` come back exactly as written instead of as literal entities. The comment parser no longer truncates every comment to an empty string: the outer `<Comment Guid="...">` wrapper shares its tag name with its nested `<Comment>` text field, and the parser now anchors the wrapper's end at the next sibling comment, a following `<Viewpoints>` block (BCF 2.1 schema order), or the markup close, so comments are read from foreign files too. On write, `BimSnippet` and `DocumentReference` are now emitted; they were parsed and typed but never written, so they were silently dropped on every export.
