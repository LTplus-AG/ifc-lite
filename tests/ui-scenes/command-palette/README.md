# Command palette hillclimbs

Two sequential, independently judged efforts. Each permits at most eight rounds.
Do not combine their verdicts or claim completion from a numerical taste score.

## UX — #8946

Goal: fast, predictable command discovery and execution with polished expert-tool density.
Frozen baseline source: `0f57524cfe347d29d68f53df7fc97f0b1f80d61a`.
Baseline screenshots remain queued; candidate behavior receipts are recorded below. No accepted round yet.

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
| 1 | Rejected for visual defects | Stable combobox focus, top anchoring and tiered search improve execution predictability | Ten browser scenarios passed at `8ae26bb7c0`; Opus found fuzzy noise, toast overlap and weak light selection contrast |
| 2 | Candidate, validation pending | Suppress fuzzy noise when direct hits exist; distinguish selection and keep modal above notifications | Fresh browser execution and independent visual verdict required |

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

## Admitted validation repair and browser setup

Draft UX PR: https://github.com/LTplus-AG/ifc-lite/pull/8950. Queue gate reports
`Mode: enforcing`; authenticated maintainer author is exempt. No ready label fabricated.

Requests `auto-5bde8b6be5344c46970384a8c98accd2` and
`auto-db9cbd907c054aebb28762aa0f3a0a94` are confirmed failed before checking code:
the shell-wrapped commands had no installed dependencies (`turbo: not found`).
The first also incorrectly forwarded `--filter` to `typecheck:tail`. These are
known failures, not uncertain outcomes. Corrected request
`auto-3266a6b51fb54c60bc8346fb806cadfd` targets production-equivalent commit
`8ae26bb7c0`, explicitly installs frozen dependencies, runs unfiltered root
`pnpm typecheck`, builds the viewer, then runs all four shards via root `pnpm test`.
The root Turbo dry-run confirmed TEST_SHARD and TEST_SHARDS reach the viewer task.
Failed-task closure was refused pending evidence verification; preserve original
publication, no source workspaces forcibly removed.

Frozen baseline build request: `auto-16416403da784015af3da6d5ee887e4e`, task
`palette-ux-baseline-fd0b1714`, source `0f57524cfe`. The temporary coordinator-owned
source worktree is `/home/louistrue/.t3/scratch/palette-baseline-fd0b1714`; remove it
when captures and task evidence are complete. It contains no unique source edits.

Ten browser scenarios are now discoverable in both viewer Playwright projects;
see `browser-scenarios.md`. Discovery is not execution. Includes desktop/narrow/short
light/dark bounds and input stability, native focus traversal, scroll-follow,
empty recovery, Escape/reopen, and real Settings execution with a bundled IFC.

## Round 1 measured outcome and round 2 candidate

This section supersedes earlier pending statuses; historical failures above remain receipts.
The corrected PC job `6135be97-00aa-4dbf-89e4-7647f3b8ba33` completed root
`pnpm typecheck` and `pnpm build:e2e` successfully at `8ae26bb7c0`; its full four-shard
viewer suite is still running. No complete suite pass is claimed.

The actual browser suite passed **10/10, zero skipped**, using the managed Windows
GPU helper and root `pnpm test:e2e:ci` at the same source. Scenarios cover all six
viewport/theme combinations, stable input position, native Tab/Shift+Tab, arrow
scroll-follow, clear recovery, Escape/reopen and Enter opening real Settings with
and without the bundled IFC loaded. The initial Linux-browser attempt timed out
capturing a screenshot; its owned test process was stopped before using the GPU
runner. Timing is incidental, not a performance benchmark.

Evidence root: `/home/louistrue/.t3/scratch/palette-ux-evidence-fd0b1714`.
`gpu-browser-result.json` records the runner and scope; `preview-observations.json`
records actual DOM rectangles and five unloaded captures. `candidate-loaded/manifest.json`
records two loaded light/dark captures, dist hash, NVIDIA adapter and no page errors.
The shared preview browser had no GPU adapter: its unloaded captures do not prove
loaded-model behavior. The separate existing GPU runner does.

Fresh Opus review `opus-round1-visual.md` rejected round 1 based on the unloaded
captures: unrelated fuzzy rows after `annot`, privacy notification over the footer
at 800×400, and a weak light-theme selected row. It preserved stable anchoring,
narrow margins, empty recovery and dark presentation. Loaded captures were produced
later and were not part of that review. No invented score or acceptance is recorded.

Round 2 removes fuzzy-only matches when any direct label, keyword or category hit
exists; preserves typo fallback; adds a semantic primary selection stripe; raises
only the palette and its scrim above toasts without dismissing them; and hides empty
navigation/run hints. New regression coverage tests translated search, annotation
results, preserved transient notifications and actual privacy-toast hit testing at
short viewport heights. Eleven browser scenarios are discoverable, not yet executed
on this revised source. Targeted lint, module size, source-text and whitespace gates
passed. Local focused tests stopped before assertions at missing sibling build output.

Cleanup: failed task `palette-ux-final-fd0b1714` was evidence-verified and closed.
Other original jobs and their locks remain protected while outcomes/publication are
reconciled. No reclaimed disk amount is claimed. Separate #8947 source inventory is
preserved outside this PR; no feature-access implementation round has started.

### Round 2 validation correction

Fresh Astra review of `7ff5de2..b65e950` found no concrete regression; it was static,
not visual acceptance. Subsequent full-suite progress exposed two failures in the
new recents tests and one old panel-entry assertion. Isolated root Turbo execution
reproduced them. Opening selected Open File beneath the newly populated recents:
the passive reconciliation effect overwrote the open effect's reset using the old
list. Reconciliation now adjusts state conditionally in the same render, preserving
the resolved identity before live insertions. Browser reopen coverage now verifies
the actual last-used Settings command is selected first. The panel test now locates
Cost/AI Chat by their accessible names, since mixed-result category text is intentional.

Focused diagnostics on the corrected working source passed **19 tests, zero skipped**
(interaction, presentation, entry and search). They use root `pnpm test --filter=@ifc-lite/viewer --only`
with the exact task confirmed by dry run and unchanged sibling outputs already built
by job6135. Temporary generated-output links are removed after diagnostics. A first
attempt without `--only` unexpectedly re-entered dependency builds due to different
Turbo environment hashes and was stopped via its owned root test process; it is not
acceptance evidence. A missing WASM runtime on the first linked-output attempt was
also a setup failure; the successful run used the real already-built runtime.

Root typecheck/build/focused validation of checkpoint `b65e950` remains queued as
`auto-f7b25554d55643998164c13bbaed7684`, PC job `bffbbdba-5ccd-4fa1-a09b-f5659181a215`.
It does not certify the later recents correction. Original baseline and full-suite
requests remain intact. The repository supports `ci:full` to request all PR lanes;
the next push uses it to obtain final-head full CI and its real viewer-dist artifact
without treating green fast CI as full coverage. The PR stays draft pending UI judgment.

The mounted fixed eight-query oracle also passed (presentation suite 5/5, zero
skipped). All 60 temporary dependency/runtime links were removed after diagnostics;
no compiled outputs were copied and no references remain. Post-commit pre-handoff
will re-evaluate cheap gates; absent local dist remains an explicit skip.
