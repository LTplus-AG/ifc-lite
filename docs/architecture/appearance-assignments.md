# Coordinated appearance assignments

F7 is being implemented as a stack under [#4420](https://github.com/LTplus-AG/ifc-lite/issues/4420).
The existing Appearance workspace now captures several scopes, previews them
together, and publishes one coordinated Apply/Undo/Redo across their models.
No new public package API or alternate IFC writer is introduced. See the
[real two-copy AC20 browser and portability evidence](evidence/coordinated-appearance/README.md).

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
Object review opens one assignment at a time and mounts at most 50 members.
Search covers the full reviewed membership by display name or GlobalId; paging
and closing the review do not discard exceptions. Closed scopes mount no object
checkboxes, so a model-sized membership does not become a model-sized DOM tree.

Saved recipes are bounded, versioned JSON. Restoring requires an explicitly
chosen loaded model for each saved slot and the original source derivative.
There is no automatic matching by file name or numeric object ID. Restore
proposes new membership and reports added, removed and renumbered GlobalIds,
removed exclusions and changed model-source hashes. The workspace requires explicit review of that proposal before preparing a new
application. Multiple original source choices can be staged before all rows in
one saved model slot are reviewed together. PDF originals are identified by
content SHA-256, not their transient document registry keys; the derivative,
page recipe and calibration must also match. Proven unchanged scopes can resume
within the same loaded session, including after switching workspace intent. Deserializing
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
The coordinator retains this property through GPU publication and supplies one
ordered Undo/Redo across all destinations.

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
browser, coordinated failure/Undo and portable export/share evidence are recorded
in the integrated acceptance linked above. Rooms currently share each active
model separately, not the complete coordinated federation.


## Coordinated publication and history

All participants are validated before any live mutation. Each model receives one
prepared operation sequence in its original order, including repeated edits to
shared styles and intermediate allocations. The coordinator prepares every IFC
transaction, asset registration and combined renderer preview before committing.
A prepublication failure rolls back all committed participants and releases every
staged resource; no model gets an independent partial history entry.

One store publication installs every model's geometry and a linked history marker
in every participating model. Toolbar Undo from any participant restores all of
them; Redo reapplies all of them. A newer ordinary edit in any participant refuses
the grouped rewind until that edit is undone. Model removal/reload retires the
whole group and releases its retained image sources, rather than replaying a
partial transaction against another model. A subscriber that throws after the
complete publication is reported as committed with an observer error, so the UI
can clear the draft and keep Undo available without offering duplicate Apply.

Behavior tests use real parsed IFC stores and the actual appearance preview
controller. They cover a failure during the second model's asset registration,
an observer exception after renderer installation, an observer exception after
complete store publication, dependency changes before Undo, participant reload,
and exact repeated-attribute/intermediate-entity Undo/Redo. Only GPU allocation is
substituted in these host tests. The integrated workspace adds the native-worker
mounted workflow and real federated browser/export/share evidence.


## Workspace flow

Choose a loaded model, source image or PDF page, scope and mapping, then use
**Add this scope**. The assignment captures those values; editing the next input
form does not alter already-captured rows. Review exceptions, order overlapping
rows, and select **Preview all assignments**. **Compare original** restores the
original display across all targets; **Apply** saves the complete reviewed result.
Duplicate model filenames carry a Model 1 / Model 2 cue in the target and export
selectors. Saved scopes retain their original query intent in the review list.

**Save recipe** downloads bounded logical JSON through the canonical download
helper. **Restore recipe** stages loaded model/source choices and presents added,
removed and renumbered IFC GlobalIds before accepting new membership. A stale
model or source cancels its live preview. Apply remains disabled until the full
assignment set has been reviewed and prepared; source or settings errors do not
silently narrow the operation.
