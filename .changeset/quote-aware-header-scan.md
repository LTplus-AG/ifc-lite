---
'@ifc-lite/parser': patch
'@ifc-lite/wasm': patch
---

STEP header scanning now treats a `/* ... */` comment as trivia, in both halves. ISO 10303-21 allows a comment wherever whitespace is allowed, so a header carrying one is ordinary input rather than malformed input.

Three things were wrong, and each lost more than the comment it came from. An apostrophe inside a comment (`/* John's export */`) inverted quote state for the rest of the file, so no record was found and the whole header was lost. A comment between a keyword and its `(` dropped that record. A comma inside a comment read as an argument separator and shifted every later field along, so `originatingSystem` came back holding the preprocessor version.

On the Rust side the same three cost more, because `parse_source_header` returning nothing makes `export_step` fall back to its own defaults: the source file's author, organization and authorization were silently replaced with `ifc-lite`.

`detect_schema` decides which schema a file is CONVERTED to on export, and had four separate ways to answer wrongly. A commented-out declaration (`/* was FILE_SCHEMA(('IFC2X3')); */`) was read as the real one. A comment after the keyword put its first apostrophe forward as the label, so `FILE_SCHEMA /* Jane's */ (('IFC4X3'))` reported `s */ ((` and wrote that into the exported header. A record with no label at all borrowed the next record's first string, so `FILE_SCHEMA(()); FILE_NAME('leak.ifc',...)` reported `leak.ifc`. And a label containing a doubled apostrophe came back still escaped, so the escaping compounded on every pass through the merge path.

Keyword matching now folds ASCII case per character rather than uppercasing a copy of the text. Indexing a copy shifted every offset after a value whose uppercase is longer (`ß` uppercases to `SS`), and a full Unicode fold read `ENDſEC` as `ENDSEC` and truncated the header.

Whitespace is ASCII on both sides, which is what ISO 10303-21 means. The two halves previously disagreed about `U+00A0` and about vertical tab.
