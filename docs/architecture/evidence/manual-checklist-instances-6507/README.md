# Independent live manual checklist instances (#6507)

The actual Chrome witness loads the public [building-architecture.ifc](https://github.com/LTplus-AG/ifc-lite/blob/326e124cf894bbaec7e56dc5126b16b07d123566/apps/viewer/public/samples/building-architecture.ifc) sample exported by IFC-manager for SketchUp and SketchUp 2024. It creates an Architecture review, answers its survey-origin question through the real verdict/comment controls, then uses **New from this checklist** to create an independent Structure review with the same question identifier and initially empty answers.

Architecture records **Pass / Architecture survey approved**; Structure records **Warning / Structure survey pending**. Switching between them and reloading the genuinely parsed IFC restores their separate decisions and comments by the source fingerprint. These are deliberate review inputs, not model-derived findings.

Documentation chooses both reviews independently while Architecture remains active in Data validation. Architecture uses **Long** with benchmarks; Structure uses **Short** with benchmarks hidden. Deleting the live Structure review disables its Refresh while the embedded snapshot remains printable. The downloaded PDF contains both review names, the real model name, Architecture guidance/comment and Structure's WARNING verdict; it omits the Structure comment as selected by the short layout.

- [Independent checklist decisions against the real IFC](independent-checklists-real-ifc.png)
- [Specific sources, long/short choices, hidden benchmarks and deleted-source snapshot](chosen-checklist-layouts-document.png)
- [Actual downloaded PDF](independent-discipline-checklists.pdf)
- [Measured deleted-source diagnostic contrast](deleted-checklist-diagnostic-contrast.json)

On 2026-09-30 the full six-case actual Chrome Documentation/PDF suite passed, including browser PDF/CMap extraction, pop-out rename/cancel/Escape, model-source/page-break export, saved validation history, three saved model-comparison pairs and these independent reviews. The final diagnostic recapture passed in 26.1s. After stacking on #6489, the combined seven-case production Chrome/PDF suite passed in 1.8 minutes, preserving independently ordered tables and coloured repeated PDF headers alongside all checklist controls. The warning uses rendered foreground `rgb(9, 9, 11)` on opaque white, measured at 19.895:1 against the normal-text AA threshold of 4.5:1.

Run from the repository root after building dependencies and starting the viewer preview at port 6657:

```sh
PLAYWRIGHT_PORT=6657 pnpm exec playwright test tests/e2e/document-text.e2e.spec.ts --project=viewer-e2e-ci --workers=1 --reporter=line
```

The legacy migration tests also preserve closed-checklist decisions whose original discipline/template identity was never stored. Matching question identifiers can recover evidence, but cannot establish that unavailable identity; unmatched entries are retained. The screenshots and PDF above show new independent instances whose identity is known.

The review correction also tests verdicts arriving after the last checklist is closed or deleted: both mounted workflows return a typed failure, show a selection-required message in both locales, and leave the persisted evidence unchanged. Reverting the guard makes precisely those two assertions fail while the other ten manual-validation cases remain green; exact restoration passes all twelve.
