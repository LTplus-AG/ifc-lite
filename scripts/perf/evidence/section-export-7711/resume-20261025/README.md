<!-- SPDX-License-Identifier: MPL-2.0 -->
# Current section-export qualification (#7711)

The runtime-producing source is `b32d4593123d517de9c2f14bbc84e60a94c191bf`,
based on main `97d8add207104d5801c0c8d62e40fa7066e848f8`. Its complete tree
matches the pre-evidence stack top `7a9e055033d56761844d0580b1ee47215117601a`.
The subsequent ancestry merge preserves that tree. This packet changes evidence
only; it does not change production code, tests, fixtures or build configuration.

[summary.json](summary.json) records current source/runtime bindings and the
scope of each result. [native-tests.json](native-tests.json) records the fresh
workspace run: 6,805 passed, zero failed, 46 ignored. Checksum freshness was
observed before compilation. [pop-gates.json](pop-gates.json) binds root
typechecking (including the tail and all 4,284 audited test files), API and
generated-table checks, documentation, lint and strict workspace Clippy.

The full export suite passed 1,999 tests with 15 skips. Its original job then
failed before the WASM contract run because the renderer build was absent;
that receipt remains failed. The follow-up prepared all packages through root
Turbo, then passed 229 real-WASM contracts (one historical-fingerprint fallback
skipped) and all seven mounted viewer tests without skips. All 182 catalogued
fixtures were restored before the current consumer runs. These counts do not
turn ignored tests or any other reported skips into coverage.

[haus-cropped.ifc.gz](haus-cropped.ifc.gz) contains the exact current export
identified by [haus-evidence.json](haus-evidence.json). It reopens with 23
trimmed elements, 34 excluded elements, 136 meshes and no checked plane
violations. [ifcopenshell-result.json](ifcopenshell-result.json) is the independent
IfcOpenShell/OCC result using the repository reference requirements and the
recorded actual engine version. It checks source/output hashes, world crop
bounds, all trimmed identities and their semantic/opening/fill links. It does
not establish full EXPRESS validity, watertight caps, colours or GPU performance.

[bundle.json](bundle.json) records the local measurement against the unchanged
engine and viewer ceilings. It is a size check, not a base-versus-branch runtime
performance comparison or a hosted CI measurement.

The first local consumer attempt reused a stale shared-Cargo artifact that
lacked the new planner. Its hashes and generated declaration diff remain in
[stale-local-wasm.json](stale-local-wasm.json) and
[stale-local-wasm-types.patch](stale-local-wasm-types.patch). The passing consumer runs
explicitly enabled checksum freshness inside their registered commands and
regenerated bindings with the official build script. No stale runtime result is
promoted to this source.

Fresh paired performance, hosted gates and review remain separate merge holds
until their observed outcomes are added. Historical packets retain their
original source scope and failures. No issue closure or merge readiness is
claimed by the functional results alone.

The oracle result in this packet remains the original result from probe source
`b32d4593123d517de9c2f14bbc84e60a94c191bf` and the recorded engine version.
For byte reproduction, extract that revision of
`tools/ifcopenshell_reference/probe_section_export.py` and use the retained
source/output bytes. Review follow-up `080f9a8030` strengthens geometry checks
and emits `checkedTrimmedGeometry`; a rerun with that probe is a separate result
and does not replace or reproduce this packet's pinned historical result hash.
