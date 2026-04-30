---
"@ifc-lite/pointcloud": patch
---

E57 reader: replace `DOMParser` with worker-safe XML parser.

`DOMParser` doesn't exist in dedicated Web Workers, where the decode
pipeline runs. Loading any `.e57` file failed with `DOMParser is not
defined` before reaching the binary section.

New `xml-mini.ts` ships a small purpose-built SAX-style parser:
open/close + self-closing tags, double-quoted attribute values, element
text, standard XML entities, and the usual skip cases (XML declaration,
DOCTYPE, comments, CDATA). Scope is deliberately narrow — just enough
for E57's shallow attribute-heavy shape — so the worker bundle stays
small.

`parseE57Xml` now walks the mini-parser's tree instead of a DOM. The
public API and decoder behaviour are unchanged; the only observable
difference is that E57 files actually load now.

Tests: 8 new tests for the XML parser (nesting, entities, mismatched
tags, attributes containing `>`), 2 for `parseE57Xml` against a
representative E57-shaped XML body. Total package tests: 58.
