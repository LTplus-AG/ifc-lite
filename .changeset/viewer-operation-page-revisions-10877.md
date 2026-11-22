---
"@ifc-lite/viewer": major
---

Viewer operation continuations now require the previous page's `page_revision` for `annotations.read`, `clash.results`, `document.inspect`, `document.library`, `filters.results`, `lists.run`, and `validation.results`. Send it with `next_offset` to continue. If the rows changed, restart at offset 0.
