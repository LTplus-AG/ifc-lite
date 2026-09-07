---
"@ifc-lite/viewer": patch
---

Rename the BCF panel's user-facing "issues" language to "topics". Per the BCF-XML specification, `Topic` is the container element and `Issue` is only one `TopicType` value among several (Request, Comment, Error, Warning, Info) — the panel title, heading, empty-state copy, and the topic-title placeholder now say "topic(s)" instead of "issue(s)". The default export filename also changes from `<model>_Issues.bcfzip` to `<model>_Topics.bcfzip`; this is only a default and does not affect archive contents.
