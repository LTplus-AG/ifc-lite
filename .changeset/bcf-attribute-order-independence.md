---
'@ifc-lite/bcf': patch
---

Fix `readBCF` silently dropping topics from spec-legal BCF files written by other tools.

`reader.ts`'s regexes for `<Topic>`, `<RelatedTopic>`, `<Comment>`, and the
comment's `<Viewpoint>` reference required `Guid` to be the attribute
immediately after the tag name. XML attribute order is not semantically
significant, so a file written with e.g. `<Topic TopicType="Issue"
TopicStatus="Open" Guid="topic-1">` failed to match: `readTopic` logged
"missing Topic element" and the whole topic -- title, comments, viewpoints --
was silently dropped with no throw and no partial result.

Our own `writer.ts` always emits `Guid` first, so every self round-trip
passed and no existing test caught this; only a file from another tool
exposed it.

Each affected site now matches the opening tag generically (`<Tag\b([^>]*)>`)
and pulls individual attributes out of the captured attribute string with a
new shared `extractAttr` helper, so attribute order can no longer matter at
any of these call sites.
