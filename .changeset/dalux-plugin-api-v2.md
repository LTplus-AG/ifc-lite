---
"@ifc-lite/source-dalux": major
---

Migrates `@ifc-lite/source-dalux` to the v2 file-source plugin contract (`manifest.api: '^2.0.0'`, declared `capabilities`/`auth`/`permissions.relay`, `Page<T>`-returning listing methods, `SourceFileRef`-based `download`, `watchRevisions` replacing `checkRevisions`) and fixes several correctness defects found in review: a relative `nextPage` link crashing pagination and discarding already-fetched pages, several pagination-truncation conditions that were previously silent, `listProjects`/file-area listing never following `nextPage` at all, a synthesized revision id that could 404 on download, unbounded upstream error bodies reaching user-facing messages, an unbounded per-file `localStorage` write on every sync, and a single invalid record failing an entire listing. The v1 id-to-location cache in `ctx.storage` (and its full-account crawl on a cache miss) is removed entirely — `SourceFileRef` and self-describing container ids make it unnecessary.
