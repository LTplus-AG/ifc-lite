---
"@ifc-lite/bcf-api": minor
---

Add `topicPaging: 'modified-date'` to `fetchProjectAsBCF` for servers that ignore `$skip` (such as buildagil's openCDE API): topics are paged by `modified_date` keyset instead of offset, deduped by guid across inclusive boundaries, and paging stops with a warning instead of silently truncating or looping. The default `'skip'` paging is unchanged.
