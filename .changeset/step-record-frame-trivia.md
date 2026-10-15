---
'@ifc-lite/export': patch
---

Apply edits to STEP records that carry trivia between their closing `)` and `;` (#7682). ISO 10303-21 allows whitespace (including a vertical tab or form feed) and `/* ... */` comments there, but the attribute, positional and retype writers looked for a literal `);`, so every edit on a record such as `#5=IFCWALL(...) ;` was dropped without a warning, and a relationship carrying a comment before its `;` was withheld from an export that deleted one of its members. Every writer now frames a record through one reader, `stepRecordFrame`, which keeps the trivia in the output; a record that opens an argument list but is not one whole record is now reported as unreadable instead of passed over in silence. The Rust mutation-log writer uses the same frame and is pinned to it by shared vectors.
