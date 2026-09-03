---
'@ifc-lite/bcf': patch
---

`readBCF` silently dropped every `Topic` label from a BCF 3.0 archive. BCF 2.1's markup.xsd repeats the label element itself (`<Labels>Structural</Labels><Labels>Urgent</Labels>`), while 3.0 wraps one `<Labels>` container around repeated `<Label>` children (`<Labels><Label>Structural</Label><Label>Urgent</Label></Labels>`). The reader's label regex only matched the 2.1 shape's direct text content, so a conformant 3.0 archive's `<Labels>` — immediately followed by a nested `<Label>` tag rather than text — matched nothing and the topic came back with no labels at all, with no warning. The reader now recognizes both shapes.

A CDATA-wrapped label (`<Label><![CDATA[Urgent & Important]]></Label>`) was dropped by the same regex, in both shapes, for the same reason: a CDATA section's content starts with `<`. Label text is now read CDATA-tolerantly — CDATA content stays literal per the XML spec, surrounding text is still entity-decoded, and real child markup still reads as not-a-text-value.
