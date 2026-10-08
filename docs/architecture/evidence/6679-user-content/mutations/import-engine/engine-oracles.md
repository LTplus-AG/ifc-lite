These are scoped, official observer reports for issue #6679.

Atomic first-write provenance: 10 passing tests become 7 passing and 3 assertion failures when the guard is removed. Queued own-receipt autosave: 11 passing tests become 10 passing and one assertion failure. Both verdicts are OBSERVED and restoration was verified. Full stdout is posted on the engine PR.

The atomic report is pinned to 8cb3dfe37376248af455203373585ec288a06044; the queued report is pinned to ac538c4a6eb9f3809b2a315ce595f13f52ff1e17. The corresponding source-hash manifests describe these historical captures. Auxiliary review-evidence branches retain both commits for replay. These are surgical guard mutations, not a claim that the generic whole-feature revert loaded or passed. Removing the new engine modules prevents its pinned feature tests from loading.

Apply each adjacent patch at its pinned commit and invoke the root test runner/official observer command recorded in the report. The remaining portable-validation, canonical-visible-draft, and reference-merge reports ship with the controls/evidence layer. No geometry or published-package API changes are involved.
