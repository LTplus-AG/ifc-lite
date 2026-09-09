# Registered drawing edit acceptance (#4308)

The actual local WebGPU viewer loaded the two-coloured seam-wall IFC and public
boulder raster already used by reference-annotation acceptance. The run used the
real dock, image picker, landmark clicks, measured-span input, Edit, Save
registration, and toolbar Undo/Redo. Browser automation only read store snapshots
for assertions; it did not inject source, reference or history state.

The registered span changed from 2 m to 4 m. The snapshots show one stable
reference ID and exact image digest through the replacement; `undo.json` matches
the original registration and `redo.json` matches the edited registration. The
screenshot shows the actual textured plane behind the unchanged blue/green IFC
walls and the saved 4 m measurement.

This run proves image registration editing and actual GPU rendering. Removed-PDF
source restoration, original native frame handling, stale Save rejection,
different-image replacement, discarded-input restoration and encoded-image
ownership through Undo are additionally exercised by mounted tests using real
PNG bytes and the native WASM calibration solver. Those tests stub only GPU
transport. An additional mounted test verifies explicit foreign-frame registration,
Discard preservation of the old frame, and restoration of that frame by Undo.
Custom imported planes and missing recipes refuse lossy restoration.

The optional Browser service was unavailable (`Browser use requires a trusted
Node REPL browser service`); this run used the existing local Playwright harness.
