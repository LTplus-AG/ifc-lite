# Independent document block titles (#6547)

The real viewer preview and exported PDF show eight independently authored headings over the committed `apps/viewer/public/samples/building-architecture.ifc` model. Its STEP header identifies SketchUp 2024 (24.0.594) and IFC-manager 5.3.3. It is external IFC ground truth, not a generated geometry fixture. The canonical demo loader loaded 444 entities and retained `building-architecture.ifc:f778982157aa24e` as the source fingerprint.

The document includes text, a real PNG, an actual element chart, an authored BCF annotation, a wall list, IDS and information reports, and an authored manual review. Both validation engines ran against the actually loaded IFC: Name presence and uniqueness each checked all four walls and passed all four. The chart aggregates 14 elements into six IFC type buckets; the wall table prints their actual Names. The BCF annotation, validation definitions and manual checklist/verdict are authored demonstration inputs, recorded in [source-inputs.json](source-inputs.json); they are not independent external review findings.

## Actual artifacts

- [document.pdf](document.pdf): actual 15,431-byte PDF, two pages, produced by the mounted **Export PDF** control through real jsPDF, svg2pdf and jspdf-autotable.
- [pdf-page-1.png](pdf-page-1.png) and [pdf-page-2.png](pdf-page-2.png): renders of those exact PDF bytes with PyMuPDF at `Matrix(1.5, 1.5)`. Both were inspected. Page one shows every authored heading and the real chart/table/report content; the manual review detail continues on page two.
- [preview.png](preview.png): actual T3 viewer screenshot after editing the real mounted title controls and reloading the persisted document. The editor and preview retain the independently authored headings.
- [document.ifclite-document.json](document.ifclite-document.json): actual persisted document, with authored headings separate from its original chart title, source/checklist names, topic GUID and image caption.
- [browser-observations.json](browser-observations.json): actual loaded model identity, persisted document and DOM preview text.
- [runtime-sources.json](runtime-sources.json): source commit/base and SHA-256 of all changed production sources, external inputs and artifacts.

The browser initially ran the actual IDS and information engines via their production modules and created the document through the store with those canonical report snapshots. Its annotation/checklist were authored for this demonstration. Each heading was subsequently entered through its actual mounted input. The first normal download was confirmed by the user and its real PDF Blob retained. A repeat after source refresh and document reload observed the real output Blob at `URL.createObjectURL`; only the redundant anchor download was suppressed to avoid another native Save dialog. The committed PDF is that repeated actual export, not a replacement PDF constructed by a test.

## Reproduce

1. Build dependencies with the root Turbo path, then start the viewer and choose **Load demo project**.
2. Import the committed document JSON through Documentation. Its list/chart re-run on that loaded model. To show the original BCF annotation, load an equivalent topic with the GUID and authored content recorded in `source-inputs.json`; otherwise its missing-source diagnostic remains visible.
3. Inspect **Block title** on text/image/chart/topic/report blocks and **Table title** on the table. Edit a heading, clear it to restore the original source heading, and reload the saved document.
4. Export PDF. The source chart/list/report names remain independent of the chosen headings. Report evidence remains embedded when its live source changes or is removed.

## Qualification and limits

At source commit `718b3cb87e06aef3971cdb3e91ac67ffbf411218` on base `217b96b57693e771e54609d11098631d17a53311`, plain root `pnpm typecheck` passed 109 tasks and included all 3,166 test files. Eight real root Turbo selections passed 97 cases with zero skips: content-title controls/persistence/import/refreshed source/layout (5), editor locale switching (8), existing document behavior (42), page breaks (5), text colors (3), IDS layouts (9), manual reports (19), and table options (6). Root lint passed 7,918 files with zero errors; 425 documentation snippets compiled; module-size and source-assertion gates passed.

The new mounted title-control fixture genuinely failed before implementation because the controls did not exist. Its production behavior uses the actual parsed public IFC and real validation engines. It verifies import refusal of non-string headings, source names retained through persistence/reload, refresh and a cross-kind saved-report selection, and heading/page/half-column bounds. Existing v10 documents remain valid; absent headings keep existing defaults, and existing table line-break behavior is preserved.

An attempted mounted SVG export under Happy-DOM failed because its XML parser rejects valid ECharts `<style><![CDATA[...]]></style>` content. The native T3 browser accepts that content and exports successfully. The attempted test was not retained and no SVG/PDF shim was introduced; the actual browser export above supplies the export evidence. These focused checks do not claim a full local repository-suite pass or a new-head CI result.

## Review correction and current-main integration

The captured browser document above contains a topic without a snapshot. A subsequent review found that a long authored topic heading could exceed its text column beside a snapshot. The new compose invariant genuinely failed first: the measured heading endpoint was 551.28 pt while the snapshot-column boundary was 355.28 pt. Commit `696bc963988cade113b9d0600bd95db20211412a` constrains only authored topic headings to the existing text-column width; the six title cases then passed with zero skips, and ordinary source-title behavior is preserved. The original PDF and runtime hashes remain recorded at their actual capture source; they do not claim to illustrate this snapshot case.

The accepted source was cleanly integrated with main `3e2779997ae165c36f6939419f9229debc73c163` at `b11f520ac0f1ec1a3d81fd606311889598888922`. Fresh plain root `pnpm typecheck` passed all 109 tasks and included all 3,174 test files. The same eight real root Turbo selections passed 98 cases with zero failures or skips, including the additional snapshot-boundary invariant. Fresh root lint passed 7,934 files with zero errors; all 425 documentation snippets compiled, and module-size, source-assertion and generated-documentation checks passed. Of the 19 production files hashed at browser capture, 18 remain byte-identical; only `compose.ts` differs because of the reviewed snapshot correction.
