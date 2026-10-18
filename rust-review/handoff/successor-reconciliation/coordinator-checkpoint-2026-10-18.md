# Coordinator checkpoint — 2026-10-18

Observed at 2026-10-18T03:38:02.400463+00:00. The live issue snapshot contains **18 open issues**. The campaign is not complete.

This supplements the historical [622-finding ledger](../../ledger.csv), [D1–D80 decisions](../../ledger.md), and [original handoff](../HANDOFF.md); it does not rewrite their dispositions. [Long-running programs](https://github.com/LTplus-AG/ifc-lite/discussions/7897) remain separate from bounded defects. Issues closed during tracking migration were moved, not declared implemented.

## Open requirements

| Issue | Evidence retained | Remaining acceptance |
|---|---|---|
| [#7890](https://github.com/LTplus-AG/ifc-lite/issues/7890) | PR #7894 contains the local fix and regression evidence. | Hosted required checks and merge remain pending; issue stays open. |
| [#7782](https://github.com/LTplus-AG/ifc-lite/issues/7782) | C4-4b source/prefix gates and artifact builds complete. C4-6a full-fixture native and WASM contract checks passed. | Five-revision measurement methodology still under review. C4-6a output checks and the remaining required C4 phases are incomplete. |
| [#7781](https://github.com/LTplus-AG/ifc-lite/issues/7781) | Corrected C2-4 and published-stack top have local Rust/API/WASM evidence. C2-5 corpus and source-equivalence evidence is retained. | Browser cohort failed/incomplete; instruction continuation is separate. C2-7 is uncompiled; C2-6 and C2-8 remain outstanding. |
| [#7779](https://github.com/LTplus-AG/ifc-lite/issues/7779) | Drafts #7906, #7914 and #7915 preserve canonical-reader and recovered symbolic/validation work. Native tests and oracle evidence are retained. | Measured instruction/timing failures remain acceptance barriers. Memo candidate 863 is built but cost is unknown; broader consumers, CI and required residual findings remain incomplete. |
| [#7714](https://github.com/LTplus-AG/ifc-lite/issues/7714) | Published drafts #7902, #7903 and #7904 preserve the implementation and measured evidence. Corrective private source 599b passed native, WASM and Python checks. | Original measured regressions remain unaccepted. Corrective six-load attribution has reviewed inputs but has not executed; current-head hosted and final performance acceptance remain pending. |
| [#7711](https://github.com/LTplus-AG/ifc-lite/issues/7711) | Drafts #7900 and #7908 are preserved. Private 239c gate-repair evidence includes scoped Rust, root typecheck, API/docs/lint, mutation/restored and independent IFC checks. | Viewer entry size still fails, including after the parent literal change. Private repairs have not been published; hosted checks, review and performance acceptance remain pending. |
| [#7655](https://github.com/LTplus-AG/ifc-lite/issues/7655) | PR #7898 fixes a separate lifecycle hazard with regression/inverse evidence. Historical-family browser bytes and a bounded diagnostic protocol are prepared. | The historical first device-loss root cause is not proven. New owner-driver review is separate from GPU execution; no new browser reproduction or post-fix acceptance is claimed. |
| [#7635](https://github.com/LTplus-AG/ifc-lite/issues/7635) | External geometry owner remains active. | Required closed-operand/kernel-result acceptance is not complete; do not duplicate or close from this checkpoint. |
| [#7633](https://github.com/LTplus-AG/ifc-lite/issues/7633) | External geometry owner remains active. | Required disconnected-patch/plane-projection acceptance is not complete; do not duplicate or close from this checkpoint. |
| [#7631](https://github.com/LTplus-AG/ifc-lite/issues/7631) | External geometry owner remains active. | Required cap-constraint/opening-cut acceptance is not complete; do not duplicate or close from this checkpoint. |
| [#7581](https://github.com/LTplus-AG/ifc-lite/issues/7581) | Human assignee andhxl publicly reported starting the Russian translation on 2026-10-18. | Preserve ownership; complete localization and review remain pending. No duplicate translation was allocated. |
| [#7292](https://github.com/LTplus-AG/ifc-lite/issues/7292) | External owner and PR #7802 retain the current correction work. | Final source-matched geometry/runtime/performance acceptance remains pending; no waiver is inferred. |
| [#7036](https://github.com/LTplus-AG/ifc-lite/issues/7036) | Existing engine/worker-pool owner retains the lane. | Cold-load, worker/default, browser, payload and memory acceptance remain pending. |
| [#6940](https://github.com/LTplus-AG/ifc-lite/issues/6940) | External geometry owner retains the MiniBIM opening-cut lane. | Final source-matched geometry and performance acceptance remains pending. |
| [#6881](https://github.com/LTplus-AG/ifc-lite/issues/6881) | Existing GPU/picking owner retains the lane. | Selected-texel readback and physical-GPU acceptance remain pending. |
| [#6729](https://github.com/LTplus-AG/ifc-lite/issues/6729) | Existing visibility owner retains the lane. | Capture evidence is not a geometry oracle; required visibility acceptance remains pending. |
| [#6709](https://github.com/LTplus-AG/ifc-lite/issues/6709) | Existing navigation/HiDPI owner retains the lane. | Gesture, restoration and quality acceptance remain pending. |
| [#6516](https://github.com/LTplus-AG/ifc-lite/issues/6516) | PR #7913 repairs offline diagnostic-bundle preparation. Actions run 39090374300 succeeded on Linux and Windows; the replacement bundle and both qualification archives were downloaded and hash-verified. | Private reporter-model diagnosis remains pending through the requested 2026-10-24 follow-up. Public controls do not prove the private cause; bundle expiry is 2026-10-25T02:31:09Z. |

## Evidence rules

- A source review, build, test result, measurement collection and accepted result are different states. A successful collector is not a performance verdict.
- Older-tree results retain their executed source identifiers. Documentation-only descendants use explicit source equivalence; they are not relabelled whole-head test runs.
- Browser device loss, timeout and incomplete cleanup are retained. No failed sample is replaced to create an accepted dataset.
- Every instruction phase is assessed independently against its approved comparison; no phase trading or ceiling increases are implied.
- External owners and the human localization assignee retain their lanes. No duplicate implementation was allocated.

## Current runtime snapshot

The memo candidate build completed; no candidate cost result exists. The original C2 five-revision browser cohort was stopped after repeated failures, preserving all completed native data and after-hash checks. Its separate instruction-only continuation is running at this checkpoint. Subsequent terminal receipts supersede this runtime snapshot.

The #6516 replacement public diagnostic bundle is [available here](https://github.com/LTplus-AG/ifc-lite/actions/runs/39090374300/artifacts/12121843799), with Linux and Windows qualification in the same run. It expires on 2026-10-25 at 02:31:09 UTC; the reporter follow-up window is 2026-10-24. Public controls do not establish the private-model cause.

The machine-readable checkpoint beside this file contains exact source/worker identities and bundle hashes. Large raw evidence remains in coordinator artifacts and the supporting PR evidence; private source proposals are not made public by this update.

## Shared CI landing

The separate storey-frame and entry-literal PRs (#7901 and #7910) remain preserved. Their combined local candidate passed its scoped root gates, but publishing a combined replacement still awaits the explicit one-defect-class-per-PR exception. This checkpoint does not grant that exception, publish the combined patch, merge a PR, or close an issue.

## Cross-cutting supporting followups

- [#7905](https://github.com/LTplus-AG/ifc-lite/pull/7905): JSON-LD exact property class labels. Local source qualification retained; hosted acceptance pending.
- Private source `897e3a67a704cae3e64de9a060cd7447beed021a`: D47 canonical source-order complex-budget admission. Independent source clear. New baseline/candidate Rust/Python validation authorized, not claimed complete. Old 525 proof covers a narrower same-set fix.
- [#7907](https://github.com/LTplus-AG/ifc-lite/pull/7907): Positional scanner fixed canaries. Local guard/test/inverse/clippy evidence retained; hosted acceptance pending.
- [#7909](https://github.com/LTplus-AG/ifc-lite/pull/7909): STEP head trivia and incomplete-list handling. Local source-pinned qualification retained; hosted acceptance pending.
- [#7911](https://github.com/LTplus-AG/ifc-lite/pull/7911): Dangling polygonal face refusal. Supporting draft; focused admitted tests/clippy verified. Historical unadmitted full-workspace claim is not accepted evidence.
- [#7912](https://github.com/LTplus-AG/ifc-lite/pull/7912): Empty and malformed performance-report rejection. CLI negative/positive evidence retained; reporter correctness is not a performance measurement.

These obligations remain explicit even where an older sweep tracker is closed. This checkpoint does not reopen, waive, or silently disposition them.
