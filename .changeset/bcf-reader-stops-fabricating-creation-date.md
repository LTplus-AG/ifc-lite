---
'@ifc-lite/bcf': patch
---

Stop the BCF reader from fabricating a `CreationDate`/`Date` when a `markup.bcf` omits the required element.

`markup.xsd` declares `Topic/CreationDate` and `Comment/Date` as required `xs:dateTime` elements with no schema default. When a non-conformant source file omitted one, the reader substituted `new Date().toISOString()` — the wall-clock time *at read time*. That value is indistinguishable downstream from a genuinely-declared timestamp (it drives topic/comment chronological sort and the "Created on" label), and it isn't even stable across repeated reads of the same untouched archive: reading the file twice produced two different "creation" dates.

`BCFTopic.creationDate` and `BCFComment.date` are now `string | undefined`; the reader leaves them undefined rather than invent a value, and the writer mirrors that omission instead of re-serializing a fabricated timestamp as if the source had declared it.
