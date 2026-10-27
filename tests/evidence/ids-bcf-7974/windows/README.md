# #7974 follow-up: BIMcollab Zoom on Windows needs a snapshot

After #8030 the reporter still saw "This issue has no viewpoint to zoom to" in
BIMcollab, Revit, Navisworks and Dalux. #8030 was verified on Mac BIMcollab
Zoom with "Capture Snapshots" switched on, but that switch is off by default.

Reproduction: the public `tests/models/ara3d/FM_ARC_DigitalHub.ifc`, validated
with `material-repro.ids` (material required; 48 of 604 elements fail). The
export was made in native Windows Chrome against production ifclite.com with
the dialog defaults, then opened through "Open BCF file (offline)" in BIMcollab
Zoom on Windows. Each issue was activated by double-clicking it. Opening a file
replaces the whole issue list.

| Archive | Snapshot | BIMcollab Zoom (Windows) |
|---|---|---|
| `main-grouped-no-snapshot.bcfzip` (production, defaults) | none | "This issue has no viewpoint to zoom to" (`bimcollab-win-main-no-snapshot.png`) |
| `main-grouped-plus-snapshot-only.bcfzip` (same archive, only a `<Snapshot>` added) | yes | Activates and selects all 48 |
| `fixed-grouped.bcfzip` (this branch, defaults) | real capture | Activates and selects all 48 (`bimcollab-win-fixed-grouped.png`) |
| `fixed-per-entity.bcfzip` (this branch, per entity, snapshots off) | placeholder | Activates (`bimcollab-win-fixed-per-entity.png`) |

The production per-entity export without snapshots failed the same way. The
camera, components and comment links are identical between the first two
archives, so the snapshot alone decides activation. In the negative screenshot,
"Selected: 48" in the status bar is left over from the previous file; the dialog
is the result.

The dialog for the fixed grouped export shows "Capture Snapshots" as checked
and disabled. Both fixed archives came from a production `vite build` of this
branch, driven over CDP in Windows Chrome.
