<!-- SPDX-License-Identifier: MPL-2.0 -->
# Admitted completion of the Holter audit

This addendum closes the two pending checks in the
[earlier partial receipt](../receipt.json). That receipt and the
[original admission refusal](../fleet-refusal.json) remain unchanged historical
records. No Holter numerical run was repeated.

A fresh fleet status permitted one new submission, job
`d749af30-d938-4389-804e-c0dd9b8d85d6` on `pop-os`.
The [actual fleet receipt](fleet-receipt.json) records admission, command,
source checkout state and terminal outcome. The numerical runs themselves
remain pre-policy legacy runs; this admission covers only the later audit.

The [finalizer](native-summary.json) rechecked all four actual modes:
`full`, `stream`, `instanced` and `fastfirst`. Every candidate matched baseline,
and every independent baseline repeat matched. It also rehashed all retained
raw manifests/JSONL, pinned linked libraries, numerical executables and collector
source files. Exact raw paths, sizes and SHA-256 values are retained in the
summary; large raw outputs remain local and are not included in this checkout.

The [supplemental execution audit](execution-record-audit.json) independently
read and hash-verified the actual raw records. CSG census sorted multisets match
baseline, repeat and candidate in every mode. Every unmasked statistics field
also matches. Any differences are limited to the ten explicitly listed
timing/cache fields. A census multiset does not establish chronological order,
per-occurrence source attribution or coverage of all worker entries.

[Source checks](source-verification.json) before and after the admitted chain
verified all 288 files against
[the frozen source manifest](../../source-manifest-ratchet-corrected.json),
SHA-256 `63bb222be30076a296d109eb6cc7d057ec3ab880f727313d62892df82d65ff93`.
The fleet checkout commit and broad worktree state are separately recorded;
those do not relabel the frozen production-source identity. Only test allowance
metadata changed after the original linked build; the numerical libraries and
executables retain their verified identities.

All positive witnesses and limits in the [original case description](../README.md)
continue to apply: actual geometry, text, properties, materials, instancing and
deferred colors were exercised. Zero UV/textures/layers/type meshes/fills provide
no positive qualification for those channels. These checks compare full exposed
structured records, beyond mesh hashes, but establish neither all-scene nor
viewer/GPU parity. No performance claim is made.

[Support](support.json) archives the exact finalizer, supplemental program,
wrapper, producer sources, commands, pins and linked build receipt. Logs and the
[hash index](receipt.json) preserve the admitted result separately from history.
