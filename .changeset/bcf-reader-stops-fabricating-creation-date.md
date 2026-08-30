---
'@ifc-lite/bcf': major
---

Stop the BCF reader from fabricating a `CreationDate`/`Date` when a `markup.bcf` omits the required element, and stop the writer from emitting an archive that omission makes schema-invalid.

`markup.xsd` declares `Topic/CreationDate` and `Comment/Date` as required `xs:dateTime` elements with no schema default. When a non-conformant source file omitted one, the reader substituted `new Date().toISOString()` — the wall-clock time *at read time*. That value is indistinguishable downstream from a genuinely-declared timestamp (it drives topic/comment chronological sort and the "Created on" label), and it isn't even stable across repeated reads of the same untouched archive: reading the file twice produced two different "creation" dates.

Two breaking changes, both on the read/write round trip for such a file:

- `BCFTopic.creationDate` and `BCFComment.date` are now `string | undefined`. The reader passes through what the file declared and substitutes nothing. Code that assumed a `string` — `formatDate(topic.creationDate)`, `new Date(comment.date)` — has to handle the missing case.
- `writeBCF` now rejects a topic or comment with no date instead of silently dropping the element, whose absence makes the `markup.bcf` fail `markup.xsd` in both BCF 2.1 and 3.0. This is the same rule the writer already applies to a BCF 3.0 topic with no `TopicType`: it will neither invent a value the source never stated nor hand back an archive it knows is invalid. The error names the element and the topic/comment guid, so a caller that does know the date can supply it and write again.
