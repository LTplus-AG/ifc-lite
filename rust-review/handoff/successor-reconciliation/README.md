# Rust findings reconciliation draft

Snapshot: 2026-10-17T22:09:01.713072+00:00. Canonical original [HANDOFF](https://github.com/LTplus-AG/ifc-lite/blob/7a44f548f67a7e57f510ecf0e79150267a4a7971/rust-review/handoff/HANDOFF.md), [ledger.csv](https://github.com/LTplus-AG/ifc-lite/blob/7a44f548f67a7e57f510ecf0e79150267a4a7971/rust-review/ledger.csv) and [decisions D1–D80](https://github.com/LTplus-AG/ifc-lite/blob/7a44f548f67a7e57f510ecf0e79150267a4a7971/rust-review/ledger.md).

**DERIVATIVE RECONCILIATION DRAFT. This is not a new authoritative ledger.** The immutable source is the transferred `rust-review/` archive pinned at `7a44f548f67a7e57f510ecf0e79150267a4a7971`. Original finding statuses and the source archive remain unchanged. This companion publishes derivative documentation only; it does not change issue or PR acceptance. This first pass uses explicit local archival evidence only; no builds/tests, source implementation review, current GitHub lookup, CI polling or95PR evidence sweep occurred.

The purpose is to preserve every original finding and its fix history while giving successors a finite verification queue. A closed issue, a merged work package, a general approval or a row's optional primary WP cannot establish a complete finding disposition on its own.

## Files

- [findings.csv](findings.csv): all622original unique IDs, with immutable status/WP/issue/PR/evidence, severity/title, original source anchor, primary-WP issue alias, draft classification, explicit per-ID PR links, closure/residual/context source references, scope caveat and next verification.
- [evidence-index.json](evidence-index.json): per-ID explicit prose claims and exact source text, curated split/residual obligations, and contextual mentions from ledger/HANDOFF/PLAN/PLAN-REVIEW/eight notes. Contextual co-occurring PR/issue numbers are **not asserted fix mappings**.
- [summary.json](summary.json): counts, limitations, five stale-open closure candidates and the unresolved issue aliases.

Source links in the CSV/JSON point directly to the immutable archive at the pinned commit. Original09a–09dsubreports use local `EDGE-N` IDs; rows retain those local anchors alongside canonical `EDGE-CLASH/LXMATH/LXPARSE/WASM-N` IDs. Public PR links are emitted only from an explicit archived per-ID PR field or a curated statement naming that ID's fix. Plain `#7684` issue references are not silently relabeled as PRs.

## Conservative classifications

| Classification | Rows | Meaning |
|---|---:|---|
| `archived-fixed-with-proof` | 30 | Immutable CSV explicitly says fixed and supplies a PR plus evidence statement. “Proof” here is the **archived record**, often terse “merged; adversarial approve”; it is not independent current code/runtime verification or proof every residual is covered. |
| `explicit-prose-closure-needs-verification` | 5 | An explicit later prose claim maps this ID to a completed fix PR, while CSV remains open. Verify before proposing a canonical disposition correction. |
| `required-pending` | 427 | Primary WP is required under D8 and this pass has no explicit per-ID closure mapping. **Verification pending does not mean the code is unfixed.** |
| `optional-by-exact-decision` | 154 | Primary WP belongs to an optional group explicitly named by D8 (`PLAN.md:21`). This records scope eligibility, **not an actual accepted deferral, wontfix or completed fix**. Required split subparts still apply. |
| `unknown` | 6 | C2-perf's six primary rows need explicit stop-line classification and evidence reconciliation. |

Counts total622. The immutable CSV's30fixed/592open is preserved verbatim; the draft's categories never overwrite it. No whole-WP association or the incomplete95-merge table was used to mark a finding fixed. D8 is a binding primary-scope decision, but it is not substituted for the required per-ID deferral record. More specific notes/remaps are retained as context/residual evidence rather than used to erase required portions.

## Five explicit stale-open closure candidates

| Original ID | Explicit archived fix claim | Verification needed |
|---|---|---|
| PROCESSING-5 | [#7727](https://github.com/LTplus-AG/ifc-lite/pull/7727), ledger263 / C6note386 | Confirm full original class and final per-fix evidence, then reconcile fixed-by status. |
| SERVER-18 | [#7727](https://github.com/LTplus-AG/ifc-lite/pull/7727), same explicit statement | Confirm server/schema-detector acceptance and any retained follow-up. |
| PROCESSING-APP-2 | [#7725](https://github.com/LTplus-AG/ifc-lite/pull/7725), ledger263 / C6note387 | Confirm original evaluated::wire/panic class and exact merged behavior evidence. |
| EXPORT-DATA-6 | [#7738](https://github.com/LTplus-AG/ifc-lite/pull/7738), ledger's explicit ID-to-merged-PR sentence | Confirm f64 profile-transform acceptance and real model evidence; preserve old issue provenance. |
| SERVER-26 | [#7718](https://github.com/LTplus-AG/ifc-lite/pull/7718), C6note's “already fixed upstream” sentence | Confirm the original memory/work budget class and full evidence rather than assuming all S3 work is covered. |

The exact source lines are recorded in the CSV/JSON, resolved against the pinned file contents. These are five verification candidates, not five new fix implementations. Other completed work may exist; this bounded first pass intentionally leaves it pending rather than deriving dispositions from work-package merge summaries.

## Scope and stale-link hazards retained

Two issue aliases remain unresolved and explicit:

- EXPORT-DATA-6: archived issue7684, primary-WP map B6f→[7690](https://github.com/LTplus-AG/ifc-lite/issues/7690). Its actual explicit fix is PR7738. Preserve7684as historical provenance; check the source report/PR before changing authoritative ownership.
- EDGE-WASM-25: archived issue7691, primary-WP map C4→[7782](https://github.com/LTplus-AG/ifc-lite/issues/7782). Its evidence field records the discovery-fold remap. Do not treat the old B7 issue's closure as proof C4's behavior is done.

Curated residual/split references preserve SERVER-24's deferred upload half versus fixed cache-read half; historical SERVER-34/EDGE-FFI-14 follow-through despite archived fixed rows; EDGE-FFI-7's consumers plus required C4-4b producer sites; CORE-13's reader/unit halves; joint XCUT-1 F2a/F3b coverage; XCUT-19's multiple homes and later D79 correction; PROCESSING-SYM-14's required/optional split; SERVER-28's beyond-C6 bug half; D69's binding remaps; and C9a's specifically optional remaining slices. These do not assert final closure or deferral and must survive any successor ledger update.

## How a successor should use the draft

1. Read the original finding and exact archival claim, then the existing PR's final diff/review/run evidence. Recheck live head/merge/ownership only for that bounded row or coherent defect class before acting. Preserve active-owner precedence and reserved slices.
2. Record exact evidence and whether it covers the **whole ID**, named subparts only, or a delegated fixed-by finding. A fixed-by mapping needs its target's proof; a proposed note/future migration is not completion.
3. Propose an explicit authoritative disposition correction with source links. If no completed proof exists, carry concrete remaining acceptance, owner and next action into durable tracking. Do not launch a replacement merely because the archive says open.
4. Preserve original values/provenance and keep updates separately reviewable. Do not rewrite the pinned archive or use this derivative table to bulk-close GitHub issues. An optional deferral needs its actual per-ID decision/risk/owner, beyond D8 eligibility.

Recent supplemental review findings remain a separate stream on [charter #7670](https://github.com/LTplus-AG/ifc-lite/issues/7670), including the [support checkpoint](https://github.com/LTplus-AG/ifc-lite/issues/7670#issuecomment-6241574992) and [D47 shared-set budget finding](https://github.com/LTplus-AG/ifc-lite/pull/7895#issuecomment-6241523952). They are not invented original IDs and are not silently folded into the 622-row count. The [preservation-gap request](https://github.com/LTplus-AG/ifc-lite/issues/7670#issuecomment-6241661433) remains binding until reconciled.
