---
'@ifc-lite/bcf': patch
---

Fail `writeBCF` for a BCF 3.0 topic missing `TopicType` or `TopicStatus` instead of silently emitting invalid markup.

buildingSMART/BCF-XML `markup.xsd` (`release_3_0`) tightens both attributes
from optional (2.1) to `use="required"`:

```
<xs:attribute name="TopicType" type="NonEmptyOrBlankString" use="required"/>
<xs:attribute name="TopicStatus" type="NonEmptyOrBlankString" use="required"/>
```

`BCFTopic.topicType`/`topicStatus` are optional in our type, and the writer
previously omitted the attribute entirely when either was unset, at both
versions -- valid for 2.1, but schema-invalid for 3.0. Every first-party call
site (`createBCFTopic`, the viewer's topic form, the IDS-to-BCF reporter, the
clash bridge) already defaults both fields, so the gap was unreachable from
the shipped app; it is reachable from the public `@ifc-lite/bcf` API
(`createBCFProject({version:'3.0'})` + a hand-built `BCFTopic` +
`addTopicToProject` + `writeBCF`), which SDK/script consumers can call
directly.

`writeBCF` now throws when writing a 3.0 topic without `topicType` or
`topicStatus`, naming the missing attribute and the topic's guid, rather than
inventing a default status the caller never chose -- a fabricated "Open" or
"Issue" would misrepresent a topic's real state to every downstream
consumer that reads `TopicStatus` for workflow logic. 2.1 output is
unaffected; both attributes stay optional there.
