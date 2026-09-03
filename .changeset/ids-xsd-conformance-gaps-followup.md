---
'@ifc-lite/ids': patch
---

`auditIDSDocument` reported five categories of document as clean that buildingSMART's `ids.xsd` 1.0 actually rejects — a wrong "valid" verdict for each. It now flags: `<specifications>` with no `<specification>` children (`ids:specificationsType` requires `minOccurs="1"`), a `<classification>` requirement missing `<system>` (`ids:classificationType` requires it, `minOccurs="1"`), `dataType` in mixed or lower case (`ids:upperCaseName` restricts to `[A-Z]+`; the IFC-schema lookup that identifies the intended type still matches case-insensitively on purpose, this is the separate check of whether the literal attribute is well-formed), `info/author` that is not an e-mail address, and `info/date` that does not lex as `xs:date`.
