# 08: Review Workflow and UI

## 8.1 The PR object

A review = (candidate layer or layer group, target ref, MergePlan, check results, BCF topic set, decision log). Lives on the registry; local-only mode degrades to CLI review (09).

## 8.2 Viewer: diff mode

- Ghosted base, color-coded added / modified / deleted / moved entities (the Three.js compare example that `fingerprint.ts` was lifted from is the seed; promote into `packages/viewer` proper)
- Component-level panel per entity: old/new per Pset/attr group, driven by the same sub-hash diff JSON the CLI and MCP emit (one diff representation everywhere)
- `@ifc-lite/lens` integration: color/filter by diff state, by author kind (agent edits in one color: instantly answer "show me everything the agent touched"), by conflict status

## 8.3 Conflict queue

Ordered list of conflict records (05 §5.3): per-entity or per-componentKey accept-ours / accept-theirs / edit-in-place. Bulk actions by selector ("theirs for all Pset_FireSafety on IfcWall"). Every decision appends a resolution op; completing the queue + green checks enables the merge button, which publishes the merge layer.

## 8.4 Checks panel

Required checks for the target ref with pass/fail and deep links into `@ifc-lite/ids` reports (entity-level failures select in 3D). Waiving requires a reason and is recorded in the merge manifest with the waiving principal.

## 8.5 Provenance panel and Time Machine

Per layer: author badge (human/agent/hybrid), intent line, scope claim vs actually-touched (mismatch warning), check history, signature status. BCF Time Machine generalizes from BCF-snapshot playback to **layer-DAG playback**: scrub through composed states at any ref, branch points and merge layers as graph nodes, click any historical state to open it read-only. bcftimemachine.com becomes the history UI of the registry.

## 8.6 BCF as review comments

Review comments are standard BCF topics bound to (review, entity, componentKey?), stored with the PR and exportable as plain BCF for foreign tools. Agents read them structurally via `get_review_feedback` (06 §6.3). No new comment format: the industry already has one.

## 8.7 Async and notification surface

Registry emits webhooks (review requested, checks finished, merged, conflict appeared after target moved). GitHub-style email/Slack notifications are a thin consumer. The Cowork/desktop agent story: "review the pending fire-safety layer" as a morning task.
