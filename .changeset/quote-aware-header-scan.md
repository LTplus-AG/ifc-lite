---
'@ifc-lite/parser': patch
'@ifc-lite/wasm': patch
---

STEP header scanning now treats a `/* ... */` comment as trivia, in both halves. ISO 10303-21 allows a comment wherever whitespace is allowed, so a header carrying one is ordinary input rather than malformed input.

Three things were wrong, and each lost more than the comment it came from. An apostrophe inside a comment (`/* John's export */`) inverted quote state for the rest of the file, so no record was found and the whole header was lost. A comment between a keyword and its `(` dropped that record. A comma inside a comment read as an argument separator and shifted every later field along, so `originatingSystem` came back holding the preprocessor version.

On the Rust side the cost is the exported file, because `export_step` falls back to its own defaults whenever `parse_source_header` returns nothing. One comment in a header was enough to turn this:

```text
FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');
FILE_NAME('export.ifc','2024-01-01T00:00:00',('Ann'),('Acme Ltd'),'ifc-lite','TheirSystem','contract-77');
FILE_SCHEMA(('IFC4X3'));
```

into this:

```text
FILE_DESCRIPTION(('Exported from ifc-lite'),'2;1');
FILE_NAME('export.ifc','',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
```

Author, organization, authorization and time stamp are emptied, the description is overwritten, `originatingSystem` becomes `ifc-lite`, and the file is converted to the wrong schema.

`detect_schema` decides which schema a file is converted to on export, and had four separate ways to answer wrongly. A commented-out declaration (`/* was FILE_SCHEMA(('IFC2X3')); */`) was read as the real one. A comment after the keyword put its first apostrophe forward as the label, so `FILE_SCHEMA /* Jane's */ (('IFC4X3'))` reported `s */ ((` and wrote that into the exported header. A record with no label at all borrowed the next record's first string, so `FILE_SCHEMA(()); FILE_NAME('leak.ifc',...)` reported `leak.ifc`. And a label containing a doubled apostrophe was cut off at the escape, so `FILE_SCHEMA(('IFC''4X3'))` reported `IFC`.

Keyword matching in the TypeScript reader now folds ASCII case per character rather than uppercasing a copy of the text. Indexing a copy shifted every offset after a value whose uppercase is longer, so a header describing `Straße` lost its entire `FILE_NAME` record, and a full Unicode fold read an unquoted `ENDſEC` as `ENDSEC` and truncated the header there. The Rust reader already folded per byte.

One behaviour is now stricter, in the TypeScript reader only. Whitespace between a record keyword and its `(` is ASCII, which is what ISO 10303-21 means, where it previously accepted any Unicode space separator. A header written with `U+00A0` there resolved before and does not now. That is the answer the Rust half already gave, so the two agree rather than one being widened to match the other.

The last-resort schema scan folds ASCII too, for the same reason. It only runs when no `FILE_SCHEMA` identifier resolves at all, and it uppercased the first 2000 bytes before looking for `IFC5` / `IFC4X3` / `IFC4` / `IFC2X3` as substrings. `ı` uppercases to `I`, so a description mentioning `ıFC5` selected IFC5 for a file that never said so. That input now falls through to the IFC4 default instead. Lower-case prose still resolves.
