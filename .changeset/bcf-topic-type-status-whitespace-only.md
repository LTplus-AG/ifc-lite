---
'@ifc-lite/bcf': patch
---

Fix `writeBCF` accepting a BCF 3.0 topic whose `topicType` or `topicStatus`
is XML-whitespace-only (e.g. `'   '` or `'\t'`) and writing it verbatim.

`writeMarkupFile`'s BCF 3.0 required-attribute check used a bare `!value`
test, which is falsy only for `undefined`/`''`. `markup.xsd` types both
attributes as `NonEmptyOrBlankString`: after XML whitespace (`#x9`, `#xA`,
`#xD`, `#x20`) is collapsed, the value must have length >= 1, so a
whitespace-only value is schema-invalid even though it is JS-truthy. The
check now also rejects a value that is entirely XML whitespace, with the
same "fail the write rather than invent a value" behavior as the
already-existing absent-value case.
