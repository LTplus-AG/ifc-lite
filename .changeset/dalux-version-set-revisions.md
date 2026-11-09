---
'@ifc-lite/source-dalux': minor
---

`DaluxBuildProvider` now implements `listRevisions`, so the viewer's file-browser "Versions" panel works for Dalux files. `capabilities.revisionHistory` flips from `false` to `true` to match.

Dalux has no endpoint that lists a file's revisions directly — only "fetch this exact revision's content" if you already have its id. Version sets are the way in: `GET /2.1/projects/{p}/version_sets` plus `GET /3.0/.../version_sets/{vs}/files` enumerate every revision a project's snapshots pinned, and sweeping them (new `commit-index.ts`) reconstructs each file's history from that.

A history row is a file revision, not a version set: two sets pinning the same revision collapse into one row carrying both set names. The current revision is included even when no set pins it. Historical rows use date, then numeric revision number for same-day ties, then stable fallback keys. Missing dates stay blank; raw user IDs are omitted. Incomplete or oversized sweeps are reported as unavailable rather than presented as a complete history.
