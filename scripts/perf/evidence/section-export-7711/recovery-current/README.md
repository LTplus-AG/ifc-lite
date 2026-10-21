<!-- SPDX-License-Identifier: MPL-2.0 -->
# Recovered section export: fresh Haus witness (#7711)

These are fresh artifacts from recovered source696a244, not replacements for the historical archive. The later stack-parent carry b3856bf changes ancestry only; its complete tree is identical. The commit adding this packet changes documentation/evidence only, not production, tests, fixtures, build configuration or runtime.

`haus-cropped.ifc.gz` decompresses to the exact output SHA in `summary.json`. `haus-evidence.json` is the original producer receipt; `ifcopenshell-result.json` is the unchanged external-oracle result. Source fixture SHA is pinned in the repository manifest. Generate it with the root Turbo export package tests and `IFC_LITE_SECTION_EVIDENCE_DIR`, then run the unchanged `tools/ifcopenshell_reference/probe_section_export.py` against the source fixture and a copy of the evidence directory.

Seven direct real-WASM facade regressions and unfiltered root typecheck passed. The output reopened in ifc-lite with no checked half-space violations. Independent IfcOpenShell/OCC reopened products and checked identities, placements, property sets, semantic relationships, opening and fill links, outside exclusion and the crop boundary. Counts and actual engine/source/output/runtime bindings are recorded in `summary.json`. Original worker receipts, logs, driver freezes and phase-file hashes remain separately retained; their failed predecessors are not relabelled green.

The oracle uses an existing IfcOpenShell0.8.5 runtime. The installed Shapely version differs from the reference lock, and the probe invokes no Shapely operation; full environment-lock parity is not claimed. This packet does not establish browser/GPU performance, a performance verdict or merge readiness. The historical measured results keep their original sources.
