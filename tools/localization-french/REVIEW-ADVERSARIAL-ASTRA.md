<!-- This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/. -->
# French adversarial review

Reviewed 2026-11-05. Head `07cb9402a96b6db2d91b79d30058b7039b9ee9ee`, German parent `f6b4dc4521`. Two confirmed findings; no score. No production edits, commits, pushes, PRs, delegates, job changes or browser launches. Only this report and its `.findings.json` companion were written. Machine/fleet and root/viewer instructions apply. Italian files appeared concurrently and are excluded, as are protected German edits and old campaigns.

## Confirmed findings

### FR-ASTRA-001 — P2: cancellation guidance reverses Undo

`apps/viewer/src/i18n/locales/fr/bulk-property-editor.ts:105`

After cancelling a partially completed bulk edit, French says **« L’annulation (Undo) rétablit les modifications déjà appliquées. »** This means restoring the modifications, whereas Undo reverses them. This is recovery guidance for a partially changed model, not a stylistic preference.

Evidence: executing the real registry from pinned Git blobs with `resolve('bulkPropertyEditor.cancelledAfter', {done: 500, total: 1000})` prints:

> Annulé après 500 entités sur 1000. L’annulation (Undo) rétablit les modifications déjà appliquées.

`BulkExecutionResult.tsx:49` selects this key for a cancelled runtime failure. `bulk-target-run.ts:74` emits that failure after already applied chunks have been recorded in one mutation batch; cancellation itself does not roll them back. Canonical English explicitly says “Undo reverts the changes already applied.” The French catalogue also correctly calls Redo « Rétablir » elsewhere. No actual model cancellation/undo interaction was run during this review.

Fix: **« L’annulation (Undo) annule les modifications déjà appliquées. »** Alternatively explicitly say Undo restores the state before these changes. Preserve both count placeholders.

### FR-ASTRA-002 — P2: empty/incomplete workflow can be green

`tools/localization-french/workflow-verdict.mjs:9`, reachable from `tools/localization-french/workflow.mjs:49`.

The verdict rejects explicit failures but never requires the acceptance checks to exist. `FRENCH_INSPECT=1` takes a real path that skips all ten checks, then the normal finalizer writes `workflow.json` and can exit zero. That output is indistinguishable by exit status from acceptance and has no explicit inspection/non-acceptance marker. A removed check or an unrecognized/skipped status also passes.

Direct execution of the pinned exported helper returned `false` (not failed) for each:

```js
{ checks: [], errors: [] }
{ checks: [{ name: 'render-device-health', status: 'pass' }], errors: [] }
{ checks: [{ status: 'skipped' }], errors: [] }
```

Fix: acceptance must require the exact expected check names, exactly once, all with `status: 'pass'`. Give inspection a separate explicit outcome/artifact. Add behavior tests for empty, omitted, duplicate and skipped checks. Existing fatal/failed/pageerror tests remain useful. **The historical final-verified report contains all ten passing checks; this defect does not establish that that run was false-green.**

## Verified invariants and semantic scope

All review code was loaded from pinned Git blobs, transpiled in memory using the installed TypeScript compiler, with no emitted source/build files. The JSON companion pins every changed file to its Git blob. One initial probe failed because its temporary in-memory resolver mishandled extensionless `.en` imports; correcting that resolver produced the results below. This was a review-probe error, not a repository defect.

- 10,607 French keys exactly equal the complete English feature-key set; existing validator returns no problems even before lazy English registration.
- All 536 identical exceptions match both the actual identical-key set and exact values. Sampled shared terms, schema examples and interpolation-only messages are legitimate; the probe does not certify every rationale linguistically.
- 466 plural messages × seven counts = 3,262 runtime cases. Counts 0, 0.5, 1, 1.5 select `one`; 2, 2.5 select `other`; 1,000,000 selects `many`. Every non-count context sentinel survives and no named placeholder remains unresolved. This proves placeholder composition, not the meaning of every translated sentence or every two-dimensional composed-message family.
- Actual startup activator negotiates fr-CH, persists URL selection, reuses storage and switches to English; HTML language follows. Every French key is owned before lazy English registration. The retained-geometry message remains French after its English feature registers.
- Inspected French startup/IDS/workflow tests and README maintenance instructions. No generic production registry/activation change exists in this French delta: the generic mechanism belongs to the German parent. Mounted IDS test was read, not independently rerun.
- Targeted comparison covered destructive/negative copy, private/public deletion consequences, change-set discard, anonymization, filter negations, storage recovery, permission refusals, schema examples and model-count warnings. The known unchecked-model wording retains its meaning as a number of unchecked models, not a model identifier. Sampled user/model values remain placeholders. A lexical schema-token check raised only English plural `IfcTasks` versus French exact `IfcTask`, not a French defect. Previous change-set quoted-name and appearance-precedence repairs are present. No additional confirmed meaning defect was found in this sample.

## Stable-source coverage and browser evidence limits

The only original clean fleet request was inspected once: `auto-b952f0c6fcbe494889f791707b35130b`, Pop worker `8d3f5f58-9650-4fcc-aa4c-d5cf4e086532`, still **queued**, evidence **pending**. Original receipt: `/home/louistrue/build-workers/worker-state/jobs/8d3f5f58-9650-4fcc-aa4c-d5cf4e086532/receipt.json`. Source is clean `fd5eaf6277940e7c8bdc30c905139f594bc725b1`. Command includes frozen install, root typecheck, selected root Turbo viewer tests, pre-handoff against the German parent, then root lint. None can be counted passed from this queued receipt. No cancellation, reroute or resubmission occurred.

Local graph `6e2fc76c-3124-4fb5-9e5d-a3c4c214146c` has exit 0 but `sourceUnchanged:false`: before `abeb878ee8`, after `fd5eaf6277`, with different worktree digests. Its passing graph is useful integration evidence, not exact stable-source coverage. The report acknowledges this limitation.

`git diff fd5eaf6277..07cb9402` contains five paths: REPORT, ROUNDS, WORKFLOW, preservation.json, and **workflow.mjs**. Viewer production/tests are identical; the acceptance harness is not. The queued request therefore covers the exact final viewer source but not the final harness as a whole. The final harness SHA256 is `43ec68fa0baea78036bc323e165cb216f434d34c09c09d67c38eb1e80e49c9b2`, matching the retained acceptance metadata. This is a narrower and more precise statement than treating all later changes as prose-only.

Read historical `evidence/build-provenance.json`, `acceptance.json` and `final-verified/workflow.json`. They record ten passes, no page errors, Intel non-fallback adapter, 14 meshes, exact selected entity, measurement/section state and parsed IDS export totals. Harness hash agrees with the pinned final script. Main and fresh negotiation pages both collect page errors. Assertions inspect actual downloaded IDS content and preserved property names, rather than source strings. Analytics HTTP 404s are reported separately and are not themselves runtime failures.

No fresh browser was opened and no old screenshot is represented as fresh evidence. Visual claims in the earlier report were not independently reproduced. The narrow check asserts document width, not absence of overlap or visible geometry; earlier visual inspection remains necessary for those claims. Local HTML/WASM hashes also do not on their own cryptographically bind arbitrary served URLs to the source. These are evidence limits, not assertions that the recorded final run used the wrong build.

Full root checks, full viewer/monorepo tests, Rust, native-speaker review and exhaustive accessibility/linguistic review were not performed here. Existing IFCX fixture skips and the pending clean aggregate remain unverified coverage. Parent can fix the two small findings and reconcile the original validation request without replacing it.
