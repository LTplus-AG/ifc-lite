# Coordinated appearance assignments

F7 is being implemented as a stack under [#4420](https://github.com/LTplus-AG/ifc-lite/issues/4420).
The first slice supplies internal scope, recipe and native preparation components.
**The existing viewer Apply action is still single-model.** The assignment list
is mounted in behavior tests; its workspace controller and atomic multi-model
publication/history consumer follow in the next slice. No new public package API
or alternate IFC writer is introduced.

## Reviewed scope and source identity

An assignment pins a model slot, current loaded model, source SHA-256 and revision.
Two copies of the same file remain separate slots, including when local EXPRESS
IDs collide. Membership records retain both current local IDs and IFC GlobalIds,
resolved from effective IFC values including overlay-created objects and GUID edits.
Class/type semantics continue to come from the native catalog. A row also owns a
copy of its image derivative identity, PDF page/crop/calibration metadata when
present, and mapping settings. Revocable thumbnail URLs and image bytes are not
part of the logical recipe.

Rows run in displayed order. A later included row replaces earlier assignments
on overlapping objects in the same model. Excluding an object from a row exposes
any earlier assignment for that object; exclusions do not affect another model.
The review reports affected, excluded and overridden counts separately.

Saved recipes are bounded, versioned JSON. Restoring requires an explicitly
chosen loaded model for each saved slot and the original source derivative.
There is no automatic matching by file name or numeric object ID. Restore
proposes new membership and reports added, removed and renumbered GlobalIds,
removed exclusions and changed model-source hashes. The next controller must
require review of that proposal before preparing a new application. Deserializing
never restores a live preview, native plan or committed history entry.

## Detached native preparation

The resolved object sets are disjoint within each model. Rows are planned
sequentially against detached effective IFC states: each native request sees the
previous row's entity allocations and shared-style changes. Native plans from the
same original bytes are never concatenated. Normal StoreEditor operations and
StepExporter serialization supply the next native request; there is no TypeScript
STEP writer or ID-remapping implementation.

Preparation checks every captured source/model guard across asynchronous steps,
and rejects changes to the assignment list itself. A failure or cancellation
releases its draft image owner and publishes no IFC, renderer or history changes.
The forthcoming coordinator must retain this property through GPU publication
and provide one ordered Undo/Redo across all destinations.

Limits are 64 rows, 8 models, 10,000 included objects per model, 128 MiB per native
IFC input and 256 MiB of retained original snapshots across models. Detached
serialization and native jobs need additional temporary memory; this is not a
256 MiB total process-memory claim. Existing image/planner limits still apply.

## Validation of this foundation

The actual WASM test uses two IFC products sharing an original surface style.
Their rows receive different mappings. It checks that the second request starts
at the first plan's allocation watermark, that preparation leaves the live view
unchanged, and that normal effective STEP export followed by native replanning
preserves both objects' distinct UV mappings. Late worker failure, cancellation,
direct SDK editing and changed-row tests verify refusal after the first row has
already prepared, including draft image-owner cleanup.

Pure membership tests cover colliding IDs, ordered exceptions, inconsistent
revisions and reload differences. Mounted list tests exercise reordering,
exclusion and removal and lock editing during publication. Real two-model mapped
browser, coordinated failure/Undo and portable export/share evidence belong to
the following integrated slice; they are not claimed by this foundation.
