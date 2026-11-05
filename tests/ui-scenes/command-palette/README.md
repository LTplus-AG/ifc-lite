# Command palette hillclimbs

Two sequential, independently judged efforts. Each permits at most eight rounds.
Do not combine their verdicts or claim completion from a numerical taste score.

## UX — #8946

Goal: fast, predictable command discovery and execution with polished expert-tool density.
Baseline source: the parent of the first implementation commit on `feat/command-palette`.
Baseline screenshots and behavior receipts are pending; no accepted round yet.

Fixed rubric: discoverability; search relevance; keyboard/pointer predictability;
accessible focus and selected-item announcement; legibility and hierarchy;
responsive light/dark coherence; recovery from empty and unavailable states.
Vetoes: broken canonical actions, lost file-picker user activation, inaccessible
keyboard execution, new runtime errors, untranslated new UI, regressions in existing flows.

Fixed scenarios: desktop 1440×900 light/dark and narrow 390×844; fresh open,
recents, exact label, task alias, whitespace, no match then clear, arrows/Enter,
IME composition, Escape/reopen, long result list, pointer after keyboard, loaded
model and no model. Use public bundled IFC fixtures for loaded evidence.

Round record must include candidate commit, hypothesis, exact changes, independent
review objections, scenario evidence, commands/receipts/skips, accept/reject and reason.
Compare candidate against frozen baseline and last accepted candidate. Fresh Opus
taste reviews; Codex implementation; Astra reasoning/behavior review. Existing
`../pair.mjs` and council protocol can supply blind image comparisons where suitable.

| Round | Status | Hypothesis | Evidence / decision |
| --- | --- | --- | --- |
| 1 | In progress | Coherent combobox focus and bounded navigation remove execution ambiguity | Implementation and primary-source research pending; not accepted |

## Complete feature access — #8947

Starts after UX iteration. Its baseline is the accepted UX candidate, independently
captured. No implementation round started. Maximum eight rounds of its own.

Goal: every user-facing viewer feature/tool/action is reachable through a functioning
palette command or a clearly named destination opening its real flow.

Inventory every ribbon/menu/panel/contextual action, settings surface, extension
contribution and dynamic tool. Matrix columns: source surface; capability; canonical
action; palette entry/destination; task aliases; prerequisites; unloaded/loaded and
unselected/selected behavior; extension availability; evidence; remaining gap.
Duplicate entry points must map explicitly. Display-only controls must carry a reason
rather than disappearing from the inventory. Complex tools must open the actual flow.

Separate rubric: inventory completeness; functioning destination; task-language findability;
truthful context prerequisites/unavailable explanations; keyboard/grouping clarity;
no regressions to accepted UX. Missing capability or broken destination vetoes completion.
Tests alone cannot prove completeness: cross-check inventory against source surfaces.

| Round | Status | Hypothesis | Evidence / decision |
| --- | --- | --- | --- |
| — | Not started | Inventory and independent baseline follow UX acceptance | No verdict |

## Release gate

Keep issues/PRs separate (stack if necessary). Full applicable root Turbo coverage,
real UI evidence, committed pre-handoff, required CI and resolved reviews precede
Mergify readiness. Production must be verified after merge; never infer deployment.
Keep compact receipts/screenshots and close owned generated storage tasks; preserve
source, model fixtures, foreign work and unknown-outcome original receipts.
