---
"@ifc-lite/source-dalux": patch
---

Fix `listProjects` (and any other single-page Dalux listing) failing with `Dalux pagination truncated at <endpoint>: N item(s) remain but the server sent no nextPage link` even when the response was a genuinely complete, final page.

`fetchPage` previously treated `metadata.totalRemainingItems > 0` combined with an absent `nextPage` link as proof the listing was truncated, and threw `DaluxPaginationError`. In practice Dalux's `/5.1/projects` (and likely other endpoints) can report a positive `totalRemainingItems` on the page that legitimately has no more pages — e.g. a project count of 1 — so that combination isn't actually anomalous. Dalux's own reference client (`bruadam/dalux-build`, `javascript/src/utils/pagination.js`) agrees: it never uses `totalRemainingItems` to decide whether to keep paging, only to log progress, and stops purely on the absence of a `nextPage` link.

`fetchPage` now does the same — a page with no `nextPage` link is always the last page, regardless of `totalRemainingItems`. The other pagination-error cases (`nextPage` link with no bookmark, or a bookmark that echoes the one just used) are unchanged, since those really do indicate a broken response.
