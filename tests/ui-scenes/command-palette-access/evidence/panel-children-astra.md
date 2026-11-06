# Independent mounted child-access review

Reviewed pinned objects ac6ce05e..2e2a017d690054f9f68a3799ce0cf3efd0fb778a: seven TSX files, fourteen mounted cases (Document 2, Lists 2, Drawing 1, Lens 1, BCF/validation/Clash 5, Sources 1, Split 2). Existing eight direct-child cases and cold-init correction were outside scope.

## Findings

1. **P2 — Clash cancellation does not establish “without saving a rule”.** `apps/viewer/src/components/viewer/CommandPalette.review-panel-access.test.tsx:106-114`. The case opens an empty draft, confirms Add is disabled, and cancels without changing any field. Its only final store assertion is `models.size === 0`; neither clashPresets nor persisted presets are checked. A cancel handler which saves an unintended preset and then clears the editor still satisfies every asserted postcondition. Also, cancellation of a configured/saveable draft is never exercised.
   - Repro/oracle mutation (proposed, not executed): change the consumer's draft onCancel at `apps/viewer/src/components/viewer/ClashSettingsDialog.tsx:350` to create a valid sentinel preset before `setDraft(null)`. Current assertions do not observe that write.
   - Minimal fix: retain the empty-draft gate assertion, then fill a named draft with valid A/B selectors and assert Add becomes enabled. Snapshot the preset collection and durable preset payload before editing; after Cancel and reopen assert both unchanged and the draft discarded. Use copied snapshots, not live references.
   - Regression oracle: accidental save-on-cancel must fail even though the editor closes and Add rule remains available. This is a test-validity finding, not an assertion that the current production cancel handler saves.

2. **P2 — PDF cancellation can miss an asynchronous export started by Cancel.** `apps/viewer/src/components/viewer/CommandPalette.visual-panel-access.test.tsx:72-77`. `waitFor` can return immediately when the dialog closes, and the test checks only a download counter before removing its listener. The real non-sheet handler starts `recordActivity` at `apps/viewer/src/hooks/useDrawingExport.ts:1077`, then awaits the jsPDF import at line 1080 and reference rasterization at line 1088 before downloading. An export erroneously started by Cancel may still be pending (or fail before downloading), leaving the asserted counter at zero. Two repetitions do not create an explicit completion boundary.
   - Repro/oracle mutation (proposed, not executed): wire the Cancel button in `apps/viewer/src/components/viewer/drawing/DrawingPdfExportDialog.tsx` to handleExport. The dialog still disappears immediately; the existing assertion can precede the asynchronous download.
   - Minimal fix: snapshot `useActivityJournal.getState().jobs` before cancellation and assert no new drawing/export activity immediately afterward, alongside the existing download-event assertion. `recordActivity` calls beginActivity synchronously before its first await (`apps/viewer/src/lib/activity/activity-journal.ts:171-174`). Preserve/restore the journal fixture state. If testing a deliberately triggered export mutation, settle that owned job before teardown.
   - Regression oracle: wiring Cancel to the export handler must fail at job creation regardless of PDF import speed or later export failure; no PDF generation or fake successful backend is needed for the unmutated case.

## Other review observations and limits

The new panel witnesses activate the real CommandPalette and MobilePanelSheet -> renderPanelBody routing. Actual body controls are required before child interaction; no surrogate body switch was found. The review/source fixture uses LocalBackend and rejects/counts fetch attempts. The document/visual helper uses the existing rejecting transport fixture, not a fabricated successful backend; document/list/lens state and persistence work are local production consumers. Drawing explicitly uses synthetic bounded-box geometry attached to parsed ownership, not a geometry-fidelity oracle.

Split uses an authored wall added through the real store to a parsed modeling fixture; it validates readSplitTarget and target ownership in one- and two-model arrangements. CommandScene resolves the actual SplitScene/SplitCursorInput, with shared stub projection and real scene portals. Mutation/entity snapshots plus undo history check cancellation beyond input text. This is neither GPU evidence nor proof of a committed split.

No further actionable defect identified by static review of these fourteen cases. All fourteen remain runtime UNRUN. No builds, typechecks, tests, browser work, mutation experiments, git mutations, push, or watch performed; pre-handoff execution was excluded by the review-only instructions. R3 observed UX acceptance does not imply complete-access acceptance, which remains UNACCEPTED.

Read root/viewer AGENTS.md, /home/louistrue/AGENTS.md and fleet policy. GitHub authenticated identity was louistrue; #8947 already assigned to louistrue and labelled claimed (also ready), verified without mutation. Fleet status: Pop reachable (4 running/5 queued), PC reachable (2 running/3 queued), Mac disabled; admission guards allowed at observation. No jobs submitted, replayed, cancelled or changed. Original push session8997 and fleet jobs left untouched.

Only this compact evidence file was created outside the checkout. No owned regenerable workspace/artifact was created; actual reclaimed bytes: 0. Source, fixtures, evidence, active/foreign work and locks preserved.

PR https://github.com/LTplus-AG/ifc-lite/pull/9012, head 2e2a017d690054f9f68a3799ce0cf3efd0fb778a (local; original push active), checks and reviews pending.
