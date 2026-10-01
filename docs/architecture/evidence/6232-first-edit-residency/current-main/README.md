<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Current-main native retest

Captured on 1 October 2026 at source and actual full-root build `50a2e628aee94c683cb9ed555428553876de34d2`, integrating main `e79f27342beb01a6f30d9b63c44795ecd118f4de`. This is the complete frame, primary-completion and resident-mesh stack. The historical proof one directory above retains its original source and runtime attribution.

Fresh owned Windows Chrome 154.0.8037.58 used a nonfallback NVIDIA Blackwell adapter. The production preview actually served WASM SHA-256 `039415545e2448ce8b1e40b14306524ee60cff29dabd97448080ac0d9e170610`, matching the qualified current-main build; Rust tree was `14b997e32f528eb3a916b6c320c9cebb901bafbe`. No store actions or manual Model/Wall launches were injected. Start blank automatically entered the Model workspace and launched `wall.place` on its own completed model, with loading false and cancellation cleared.

The actual UI sequence was Start blank, two plan clicks, Escape twice, Ctrl+Z, Ctrl+Shift+Z, File → Export IFC (with changes) → Export, then the completed native Windows download through a fresh page's canonical file input.

- [Completed blank project](loaded-blank.png) and [empty plan](blank.png): Wall is already active; zero meshes and history entries.
- [First wall](wall.png): one plan cut, one CPU mesh, one resident flat part, twelve triangles and one Undo entry. The inspector shows approximately 3.191 m length, 0.20 m thickness and 3.00 m height.
- [Undo](undo.png): zero CPU meshes and plan cuts, no Undo entries, one Redo entry. Its [GPU color readback](undo-renderer-color.png) is empty. Owner enumeration follows current CPU owners; this is not a separate query of the removed wall's allocation.
- [Redo](redo.png): one CPU and resident part, twelve triangles, one Undo entry. Complete CPU mesh arrays and world triangle corners equal the first wall.
- [Fresh reload](reload.png): one CPU and resident part with triangle corners identical to Redo. Reload adds a geometry hash, so complete CPU metadata identity across reload is not claimed.

All three wall states have IFC Z-up bounds X `[-1.595744133, 1.595744133]`, Y `[-0.1000000015, 0.1000000015]`, Z `[0, 3]` metres, derived from captured world triangle corners. [Facts](facts.json.gz) retain actual owner metadata, mesh arrays, coordinate frame, history depths and download-completion events. Flat snapshots describe scene-part metadata; instance is a boolean, and corners are world triangle positions. They are not GPU upload-byte hashes.

The [completed IFC](Untitled_Project_export.ifc) contains 2,849 bytes, SHA-256 `3fb3b862454090ec4536a75b9617f841629a6022d88358f8b92cfc7db511e029`. Chrome reported download completion before those actual bytes were reloaded. Hardware renderer color readback succeeded at all six states, including [Wall](wall-renderer-color.png), Undo and [reload](reload-renderer-color.png). No rendering-performance claim is made.

[Qualification](qualification.json): normal dependency graph and full root build passed, plain root typecheck covered all 3,236 test files, 35 focused cases passed with zero skips, root lint checked 8,110 files with zero errors, API snapshot remained at 9,165 exports, and 428 documentation snippets compiled (12 existing illustrative skips). Strict MkDocs and MPL/test-wiring/module-size/source-text-assertion/changeset/bump-level gates passed. The resident-mesh official oracle observed seven passes, then two passes and five assertion failures on reverted production, with clean restoration verified. The separate completion oracle observed 24 passes, then 14 passes and ten assertion failures. This proof covers one native metre model and one authored wall; metre/millimetre, federation, cancellation, supersession, multipart, retry and mixed-edit invariants use real-engine mounted tests. #6232 remains open.

The [lossless facts archive](facts.json.gz) preserves the exact original UTF-8 JSON (79,599 bytes), SHA-256 `990e91deb7cafd2a82c1fff5bd08d9279935c423f3abeb7d85da22fba058dd8d`. Decompress with `gzip -dc facts.json.gz > facts.json`; no fields, mesh arrays or evidence were removed. All source/runtime and observation limits above remain unchanged.
