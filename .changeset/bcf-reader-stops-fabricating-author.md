---
'@ifc-lite/bcf': major
---

Stop the BCF reader from fabricating a `CreationAuthor`/`Author` when a `markup.bcf` omits the required element, and stop the writer from emitting an archive that omission makes schema-invalid.

`markup.xsd` declares `Topic/CreationAuthor` and `Comment/Author` as required `UserIdType` (string) elements with no schema default — the same shape as `Topic/CreationDate`/`Comment/Date`, which a prior release already stopped fabricating. When a non-conformant source file omitted one, the reader substituted the literal string `'Unknown'`, which is indistinguishable downstream from a genuinely-declared author name.

Two breaking changes, both on the read/write round trip for such a file:

- `BCFTopic.creationAuthor` and `BCFComment.author` are now `string | undefined`. The reader passes through what the file declared and substitutes nothing. Code that assumed a `string` — `topic.creationAuthor.split('@')[0]`, string-templating `comment.author` — has to handle the missing case.
- `writeBCF` now rejects a topic or comment with no author (and a topic with `ModifiedDate` but no `ModifiedAuthor`/`CreationAuthor` to fall back to) instead of silently emitting an author-less element, whose absence makes the `markup.bcf` fail `markup.xsd` in both BCF 2.1 and 3.0. This is the same rule the writer already applies to `CreationDate`/`Date` and to a BCF 3.0 topic with no `TopicType`: it will neither invent a value the source never stated nor hand back an archive it knows is invalid. The error names the element and the topic/comment guid, so a caller that does know the author can supply it and write again.
