# IFC commit diff walk

From the repository root, with `ifc-lite` installed on PATH:

```sh
node tools/ifc-history/walk.mjs /path/to/local/repository
# Select another tip or executable:
node tools/ifc-history/walk.mjs /path/to/local/repository --ref main --ifc-lite /path/to/ifc-lite
```

This read-only tool walks the selected tip's first-parent history, oldest first.
For each changed `.ifc` blob at an existing path it extracts the previous and
current revisions into temporary files and runs `ifc-lite diff --by-content
--json`. It prints one aggregate line per commit containing pairs, with the
pair's commit IDs and quoted file path. Other commits print nothing. Temporary
files are removed even on failure. The working tree, index and refs are untouched.

Counts describe entities, not files. Content matches are reported separately,
with their kinds: regenerating GlobalIds appears as `N renamed`, with zero added
and deleted, rather than being folded into unchanged. The content-match total
counts engine match groups (an ambiguous group may contain several entities).

A new file seeds a revision chain; deletion ends it. Path renames start a new
chain. Merge commits compare their resulting tree along the first parent, so
merged deliveries are exercised once rather than comparing unrelated branches.
Uncommitted files and symlinked `.ifc` entries are ignored. Repository paths
are relative to the repository root even when invoked from a subdirectory. Git or diff failures stop the walk with a nonzero
exit; pair failures identify both full commit IDs and the path. Invalid JSON/counts fail
as well. CLI calls time out after five minutes. SIGINT removes the scratch directory
and interrupts the active diff process. No persistence or CLI verb is added.

Tests use the checked-in synthetic `tests/fixtures/cli-retained/layered-wall.ifc`,
not the local corpus. After a root `pnpm build --filter=@ifc-lite/cli` (including
current diff WASM), run `node --test tools/ifc-history/*.test.mjs`. CI runs this
suite once in the fast-lane Node guards job against its built package artifact.

Blob bytes stream directly to temporary files through Git smudge filters (including
Git LFS). An unresolved LFS pointer stops with an explicit LFS diagnostic; install
and configure Git LFS and fetch the referenced objects first. Diff JSON has a
256 MiB output limit; exceeding it reports that output was truncated. History
scans use IFC-only tree deltas rather than listing every file at every commit.
