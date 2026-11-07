---
'@ifc-lite/source-dalux': minor
---

`DaluxBuildProvider` now implements `listRevisions`, so the viewer's file-browser "Versions" panel works for Dalux files. `capabilities.revisionHistory` flips from `false` to `true` to match.

Dalux has no endpoint that lists a file's revisions directly — only "fetch this exact revision's content" if you already have its id. Version sets are the way in: `GET /2.1/projects/{p}/version_sets` plus `GET /3.0/.../version_sets/{vs}/files` enumerate every revision a project's snapshots pinned, and sweeping them (new `commit-index.ts`) reconstructs each file's history from that.

A revision is a pinned *file revision*, not a version set: two sets pinning the same revision collapse into one entry carrying both set names, because the model did not change between them. Ordering prefers Dalux's own revision number (`File.version`) over timestamps, because `lastModified` carries no time component — every revision uploaded on one calendar day ties, which on a live project is the normal case, not an edge case.

Scoped to reading history only. Dalux's write/upload paths, and the generic cross-provider commit/model API (`SourceCommit`, `listCommits`, `loadCommit`, …) some other providers may grow later, are untouched here.
