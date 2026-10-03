<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Canonical ring-search opportunity screen (#6537)

Do not prototype linked-neighbour indices as a general performance fix from this
screen. The public slab and Holter show little or no searching beyond adjacent
live vertices. House and Revit CSG contain additional probes, but counts alone
do not establish that this work dominates time or that new neighbour arrays pay
for their construction. The synthetic collinear-ring test proves quadratic
worst-case work, not a representative-model hotspot.

| Native fixture | Live visits | Actual neighbour probes | Extra probes above two per visit | Maximum prev/next distance |
| --- | ---: | ---: | ---: | ---: |
| IfcOpenShell public #994 slab | 8,859 | 17,857 | 139 | 2 / 2 |
| AC20 house | 1,223 | 2,623 | 177 | 3 / 3 |
| Revit ISSUE_129 | 78,311 | 184,105 | 27,483 | 77 / 77 |
| Holter tower | 22,392 | 44,784 | 0 | 1 / 1 |

These are whole-fixture native work counts. They do not isolate slab host `#344`,
reconstruct older raw rings, rank CDT/conform/repair time, or establish a browser
worker-pool speedup. Max distance includes the successful probe: adjacent is one.
Calls enter after the canonical rim weld; short rings count calls and inputs,
but perform no sweeps or probes. Work includes speculative operations discarded
by later routing. Counters use fixed-sized opt-in storage; the shipping algorithm
is unchanged.

The actual canonical `process_geometry` route selected RTC and default options.
A single Rayon worker performed the reset, processing and drain on one thread;
draining on the main thread after a default parallel pass would lose worker
counts. The feature-off controls used the same runtime sources and compiler.
All four fixture pairs had identical serialized mesh/metadata/frame captures,
per-Express-ID counts and exact ordered geometry-payload FNV. Native-only
instances were required empty. Captures exclude processing times; the FNV has
its shared documented exclusions. This is produced-output identity, not an IFC
reference-oracle fidelity verdict, GPU/picking test, or federation qualification.

`summary.json` records fixture download URLs, sizes and SHA256, counter totals,
capture SHA256 and geometry FNV. Fixture files and geometry captures are not
committed. Public #994 is pinned to IfcOpenShell/files commit
`9fc2267d7f1ff35284c5b0fc28cc97bff7ace8e7`; the other three match the committed
fixture manifest. The build receipts retain base `0a16f532c`, uncommitted
runtime source hashes, the pinned compiler and frozen binary hashes. Diagnostic
runtime code is present in this PR; source hashes distinguish its exact measured
state from later documentation or evidence additions. Initial adapter receipts
are preserved. The current `*-build-receipt-v2.json.gz` pair includes the atomic
output guard, whose controls and real input-alias refusal are also retained.
All four guarded feature-on/off pairs reproduced the complete initial reports
byte-for-byte; the output guard did not change measured work or payloads.

The `.json.gz` files are lossless archives of complete native reports and build
receipts. `archive-manifest.json` pins both original and compressed digests and
sizes; decompress before inspecting. Reports retain all per-Express-ID counts,
not a favorable subset. The guardian receipts retain completed resource-bounded
functional runs. Their timestamps and sampled RSS are not performance or
physical-peak measurements. No elapsed-time comparison is qualified here.

Reproduce with the commands in
[`opening-work-diagnostic.md`](../../opening-work-diagnostic.md), using the
recorded public inputs. Compare feature-on/off capture bytes and FNV before
interpreting work. Revisit neighbour indexing only after a canonical public-model
profile demonstrates substantial search cost, then preserve exact ascending
sweep order, predicates, coordinates and topology and qualify ordinary
end-to-end worker-pool A/B on representative fixtures.

The [oracle controls](oracle-controls/summary.json) retain two surgical changes
at source head `e975a29ff`: count only the first predecessor probe, and add
job maximum distances instead of taking their maximum. Each official oracle
collected six passing controls, then four passes and two genuine assertion
failures; independent restored runs passed all six. Test registration and
production interfaces stayed present, and restoration was byte-verified. The
five feature-specific Rust tests explicitly declare their feature so the oracle
schedules them. These are correctness controls, not performance comparisons.

The separately retained whole Node production revert removes the new helper
export and cannot load its tests (`REVERT-BROKE-BUILD`, exit 3). It establishes
no assertion observation. Complete logs, applied patches and guardian receipts
are losslessly archived with digests in `oracle-controls/`; the original native
receipts remain unchanged. Later evidence-only commits do not relabel the
qualified source head.

The [streaming controls](streaming-controls/summary.json) qualify the review
fixes to the native capture adapter. The adapter drops the IFC input after
processing, serializes one mesh Value at a time with the original float
formatting, and hashes accepted capture bytes without retaining the full
serialized capture. The canonical result and largest single-mesh Value remain
resident; this establishes no memory-performance verdict. Reported write or
serialization failures attempt cleanup of the newly-created partial target;
cleanup failures preserve both causes. Existing targets are refused.

Five adapter controls pass with features enabled and disabled, including a real
partial-file write failure followed by successful retry and the float-format/hash
compatibility contract. Both strict workspace Clippy runs and genuine release
builds pass. All four streamed feature-on/off captures and complete report bytes
match their respective v2 outputs. Full post-build source inventories remain
unchanged after the suites; the receipts explicitly disclose that no full
pre-feature-build inventory was captured. Raw receipts and logs are preserved
in a separate digest manifest, leaving earlier qualifications untouched.
