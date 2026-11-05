# Command palette hillclimbs

Two sequential, independently judged efforts. Each permits at most eight rounds.
Do not combine their verdicts or claim completion from a numerical taste score.

## UX — #8946

Goal: fast, predictable command discovery and execution with polished expert-tool density.
Frozen baseline source: `0f57524cfe347d29d68f53df7fc97f0b1f80d61a`.
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

## Research and round 1 objections

Primary references: [PostHog Command K UX](https://github.com/PostHog/posthog/blob/master/frontend/src/lib/components/CommandKSearch/COMMAND_K_SEARCH_UX.md),
[Theo's relevant video](https://www.youtube.com/watch?v=xq0eB8vxeqk),
[tstack](https://github.com/t3dotgg/tstack), and the published experiments
[t3code #24865](https://github.com/pingdotgg/t3code/pull/24865) and
[#25251](https://github.com/pingdotgg/t3code/pull/25251).
Opus verified the video metadata, not its audiovisual contents; no claim of watching it.
The initially suggested video `5Bmp9cz1JN8` was not the relevant UI video.

The applicable principles are stable layout/selection, tiered local search, contextual
row labels, and fresh independent critique. PostHog's network search, AI handoff and
filter syntax are outside this palette's scope. Preserve semantic colour; council
preferences alone cannot establish correctness or justify removing useful state.

Round 1 checkpoint: `4bbaa9f045886353902d413084f1e07dd3d3575a`.
Astra's static review found selection reconciliation missing a dependency after a
whitespace edit, composition Escape reaching Radix capture dismissal, and a Happy
DOM Tab assertion that did not exercise native traversal. Coordinator corrected the
first two and added behavioral regressions; removed the misleading Tab assertions.
Real Tab traversal remains a required browser scenario. These fixes are not yet verified.

Cheap checks at the checkpoint: module size, i18n literals, diff whitespace passed.
The implementation agent's direct focused test stopped at missing built load-trace
output before assertions; it is NOT acceptance coverage. Root Turbo typecheck was
submitted through fleet as `auto-ff97536d4c494c23a2373d31e42ba82d`, storage task
`palette-ux-r1-fd0b1714`, PC job `2854b4bf-8bcd-4f51-ac12-7d6fdc0c826c`.
Its original receipt is pending; do not resubmit it to recover its outcome.

The presentation candidate adds a palette-only top anchor, ranked search tiers with
recency tie-breaking, localized mixed-result categories, clear-search recovery, and
an explicit close control. Fresh taste judgment remains pending real captures.

Fleet blocker inspection found dead recorded owners on PC. Supported original
`job-recover-capture` for job `3d1c276d-ee46-4ce4-b5fe-f08b4737575a` refused with
`active or queued resource owner`; no guard was bypassed and no foreign process or
workspace was removed. Other stale ordinary reservations do not match the deployed
service-only dead-owner recovery protocol. No bytes reclaimed by this inspection.

Combined-candidate Astra review found a blocking CSS composition error: Tailwind 4
uses independent `translate`, so inline `transform: translateX(-50%)` compounded
horizontal positioning and left inherited vertical centering active. Fixed by
removing inline transform and overriding vertical translation with `translate-y-0`.
Browser bounding rectangles before/after filtering are still mandatory. Review
found no further concrete ranking defects; this is static evidence only.

Validation continuation: candidate `a6b232e26b6ca3b559f9f3e2fe6169f067857658`
root typecheck plus full four-shard viewer suite submitted as
`auto-5bde8b6be5344c46970384a8c98accd2`, PC job
`faf298e8-1840-435d-bcc6-a086e802556f`, storage task
`palette-ux-candidate-fd0b1714`. This tests the pre-positioning-fix checkpoint,
not the final CSS fix `1d72380b1f`; final-head coverage remains required.
Both requests are queued behind original fleet reservations; keep their identities.

Git history was deepened by 220 commits for the silent-revert gate. Pre-handoff
then exited 0: all evaluated gates passed, with retained-free viewer SKIPPED
because `apps/viewer/dist` does not exist. That skip is not a built-viewer pass.
No browser captures or full test verdict yet, and no round accepted.
Coordinator escalated the concrete reservation recovery blocker to the parent
for owner coordination. No source or foreign outputs removed; no bytes reclaimed.
Owned tasks remain open while original job outcomes are pending.
