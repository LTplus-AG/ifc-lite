/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { clashDiscussion, seedClashResult, typedReport } from '@/test/ai-report-fixture';
import { printDocumentText } from '@/test/document-pdf-text';
import { readContentRows } from '../storage/content-database';
import { aiBlockOrigin } from '../document/ai-report-types';
import { renderTemplate } from '../document/bindings';
import { documentContent, exportDocument, loadDocuments, parseDocumentFile } from '../document/persistence';
import type { DocumentSpec, TextBlock } from '../document/types';
import { cancelAssistant, replaceEvidence, useAssistant } from './conversation';
import { captureEvidence } from './evidence';
import { prepareReportDraft, saveReportDraft } from './report-draft';
import { REPORT_LANGUAGES } from './report-language';
import { applyReportRefresh, planReportRefresh } from './report-refresh';

const initial = useViewerStore.getState();
afterEach(() => { cancelAssistant(); useViewerStore.setState(initial, true); });
const slot = (document: DocumentSpec, name: string) => document.blocks.find((block): block is TextBlock =>
  block.kind === 'text' && block.aiProvenance?.slot === name);

// #7302: explicit presentation contract, not a provider/native-speaker quality verdict.
const headings = {
  en: 'Narrative for review', de: 'Text zur Prüfung', fr: 'Texte à examiner', it: 'Testo da esaminare',
  es: 'Texto para revisión', nl: 'Tekst ter beoordeling', pt: 'Texto para revisão', da: 'Tekst til gennemgang',
  sv: 'Text för granskning', nb: 'Tekst til gjennomgang', fi: 'Tarkistettava teksti', pl: 'Tekst do przegladu', cs: 'Text k posouzení',
};
for (const language of REPORT_LANGUAGES) {
  test(`#7302 ${language} native compose uses its chosen report language and unchanged source facts`, () => {
    clashDiscussion(typedReport('Native invariant [E1].', [{ text: 'E1 distance is -20 mm.',
      facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] }], language));
    const draft = prepareReportDraft(`Catalogue ${language}`, language);
    assert.equal(slot(draft.document, 'narrative-heading')?.text, headings[language]);
    assert.equal(draft.document.aiReport?.language, language);
    assert.equal(draft.claims[0].status, 'supported');
    assert.match(slot(draft.document, 'claim-facts:C1')?.text ?? '', /E1 distance: -0\.02 m/);
    const appendix = draft.document.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n');
    assert.match(appendix, /E1\s+IfcWall vs IfcPipeSegment · hard · major · -0\.02 m \(estimate\)/);
    assert.equal(draft.document.aiReport?.narrative, 'Native invariant [E1].');

  });
}

test('#7302 French native Save/IDB/reload/export/import/PDF retain chosen language and independently checked values', async () => {
  clashDiscussion(typedReport('Coordination requise [E1].', [{ text: 'Chevauchement de 20 mm.',
    facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] }], 'fr'));
  const draft = prepareReportDraft('Rapport français', 'fr');
  assert.equal(await saveReportDraft(draft, draft.documentJson), true);
  const row = (await readContentRows('document')).find(item => item.id === draft.document.id);
  assert.ok(row);
  const decoded = documentContent.decode(row.payload);
  assert.ok(decoded);
  assert.equal(decoded.aiReport?.language, 'fr');
  const loaded = (await loadDocuments()).find(item => item.id === draft.document.id);
  assert.ok(loaded);
  assert.equal(slot(loaded, 'claims-heading')?.text, 'Affirmations vérifiées par rapport aux données capturées');
  let publication: Blob | undefined;
  const original = URL.createObjectURL;
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); publication = blob; return 'blob:report-language'; };
  try { exportDocument(loaded); } finally { URL.createObjectURL = original; }
  assert.ok(publication);
  const imported = parseDocumentFile(await publication.text());
  assert.equal(imported.aiReport?.language, 'fr');
  assert.equal(slot(imported, 'narrative-heading')?.text, 'Texte à examiner');
  assert.match(slot(imported, 'claim-facts:C1')?.text ?? '', /Étayée par les données capturées/);
  const printed = await printDocumentText(imported);
  assert.deepEqual(printed.unresolved, []);
  assert.match(printed.text, /Texte à examiner/);
  assert.match(printed.text, /E1 distance: -0\.02 m/);
  assert.match(printed.text, /IfcWall vs IfcPipeSegment/);
});

test('#7302 German native refresh localizes changed/missing facts and preserves reviewer ownership/deleted slots', async () => {
  clashDiscussion(typedReport('Prüfung nötig [E1].', [
    { text: 'E1 überlappt um 20 mm.', facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] },
    { text: 'E2 überlappt um 35 mm.', facts: [{ citation: 'E2', field: 'distance', value: -35, unit: 'mm' }] },
  ], 'de'));
  const saved = prepareReportDraft('Prüfung', 'de').document;
  const old = slot(saved, 'claim-facts:C1'); assert.ok(old);
  assert.ok(old.text.startsWith('Durch erfasste Daten unterstützt · Quellen: E1\n'),
    'the browser review locates the actual saved German caption, independently of UI language');
  const edited: DocumentSpec = { ...saved, blocks: saved.blocks.filter(block => block.id !== slot(saved, 'coverage')?.id)
    .map(block => block.id === old.id ? { ...old, text: 'Auf der Baustelle prüfen.' } : block) };
  seedClashResult([-0.04, -0.035, -0.05], [0, 2]);
  const plan = planReportRefresh(edited, captureEvidence('clash'));
  assert.deepEqual(plan.claims.map(claim => claim.changes[0].kind), ['changed', 'missing']);
  const kept = applyReportRefresh(edited, plan);
  assert.equal(kept.aiReport?.language, 'de');
  assert.equal(slot(kept, 'coverage'), undefined);
  assert.equal(slot(kept, 'claim-facts:C1')?.text, 'Auf der Baustelle prüfen.');
  assert.equal(aiBlockOrigin(slot(kept, 'claim-facts:C1')!), 'human-edited');
  assert.match(slot(kept, 'refresh-summary')?.text ?? '', /Nachweise aktualisiert:.*Revision 2/);
  assert.match(slot(kept, 'claim-refresh:C1')?.text ?? '', /1 zitierte Werte geändert/);
  assert.match(slot(kept, 'claim-refresh:C2')?.text ?? '', /1 fehlen/);
  assert.match(slot(kept, 'claim-facts:C2')?.text ?? '', /Durch erfasste Daten widerlegt/);
  const replaced = applyReportRefresh(edited, plan, new Set([old.id]));
  assert.match(slot(replaced, 'claim-facts:C1')?.text ?? '', /behauptet -20 mm, erfasst -0\.04 m/);
  assert.equal(aiBlockOrigin(slot(replaced, 'claim-facts:C1')!), 'ai-generated');
  const printed = await printDocumentText(kept);
  assert.deepEqual(printed.unresolved, []);
  assert.match(printed.text, /Berichtssprache: de · Revision 2/);
  assert.match(printed.text, /Nachweise aktualisiert \(Revision 2\): 1 zitierte Werte geändert/);
  assert.match(printed.text, /Auf der Baustelle prüfen\./);
});

test('#7302 French supported/unverifiable/contradicted claim captions do not change native verdicts', () => {
  clashDiscussion(typedReport('Éléments à vérifier [E1].', [
    { text: 'A', facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] },
    { text: 'B', facts: [{ citation: 'E1', field: 'missingNativeField', value: 'unknown' }] },
    { text: 'C', facts: [{ citation: 'E1', field: 'distance', value: -99, unit: 'mm' }] },
  ], 'fr'));
  const draft = prepareReportDraft('États', 'fr');
  assert.deepEqual(draft.claims.map(claim => claim.status), ['supported', 'unverifiable', 'contradicted']);
  assert.match(slot(draft.document, 'claim-facts:C1')?.text ?? '', /^Étayée par les données capturées/);
  assert.match(slot(draft.document, 'claim-facts:C2')?.text ?? '', /^Non vérifiable à partir des données capturées/);
  assert.match(slot(draft.document, 'claim-facts:C3')?.text ?? '', /^Contredite par les données capturées/);
  assert.match(slot(draft.document, 'claim-facts:C3')?.text ?? '', /value differs from the captured value/,
    'native diagnostic remains verbatim; only report-owned wrappers are translated');
});

test('#7302 French native sample/truncation and outside-sample refresh remain explicit, not contradicted', () => {
  clashDiscussion(typedReport('Échantillon [E100].', [{ text: 'E100 : -20 mm.',
    facts: [{ citation: 'E100', field: 'distance', value: -20, unit: 'mm' }] }], 'fr'), Array(121).fill(-0.02));
  const draft = prepareReportDraft('Échantillon', 'fr');
  assert.equal(draft.document.aiReport?.evidence.includedRows, 100);
  assert.equal(draft.document.aiReport?.evidence.totalRows, 121);
  assert.match(slot(draft.document, 'coverage')?.text ?? '', /Ceci est un échantillon/);
  // Native c99 remains in the complete run but moves outside the first 100 captured rows.
  seedClashResult(Array(121).fill(-0.02), Array.from({ length: 121 }, (_, i) => (i + 100) % 121));
  const plan = planReportRefresh(draft.document, captureEvidence('clash'));
  assert.equal(plan.claims[0].changes[0].kind, 'unsampled');
  assert.equal(plan.claims[0].after, 'unverifiable');
  const refreshed = applyReportRefresh(draft.document, plan);
  assert.match(slot(refreshed, 'claim-facts:C1')?.text ?? '', /hors de l’échantillon capturé/);
  assert.match(slot(refreshed, 'claim-refresh:C1')?.text ?? '', /n’ont pas pu être revérifiées/);
  assert.match(slot(refreshed, 'refresh-summary')?.text ?? '', /hors de l’échantillon capturé : 1/);
});

test('#7302 source-supplied long native rule label reports actual projection truncation in German', () => {
  clashDiscussion(typedReport('Prüfung [E1].', [{ text: 'E1 : -20 mm.',
    facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] }], 'de'));
  const state = useViewerStore.getState(); const result = state.clashResult; assert.ok(result);
  const native = { ...result, clashes: result.clashes.map(clash => ({ ...clash, rule: 'Regel'.repeat(400) })) };
  useViewerStore.setState({ clashResult: native, clashRawResult: native });
  // Reattach through the same native capture path, never forge a truncated flag.
  const messages = useAssistant.getState().messages;
  replaceEvidence(captureEvidence('clash')); useAssistant.setState({ messages });
  const draft = prepareReportDraft('Gekürzt', 'de');
  assert.equal(draft.document.aiReport?.evidence.projectionTruncated, true);
  assert.match(slot(draft.document, 'coverage')?.text ?? '', /Einige Nachweiswerte wurden gekürzt oder ausgelassen/);
  assert.equal(draft.claims[0].status, 'supported');
});

test('#7302 unsupported imported report language refuses native regeneration rather than silently switching to English', () => {
  clashDiscussion(typedReport('A [E1].', [{ text: 'A', facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] }]));
  const draft = prepareReportDraft('Legacy').document;
  assert.ok(draft.aiReport);
  const decoded = documentContent.decode({ ...draft, aiReport: { ...draft.aiReport, language: 'unavailable-language' } });
  assert.ok(decoded, 'existing portable codec preserves an unknown report language rather than inventing one');
  assert.throws(() => planReportRefresh(decoded, captureEvidence('clash')), /Unsupported native report chrome language/);
  assert.equal(decoded.aiReport?.language, 'unavailable-language');
});

for (const language of REPORT_LANGUAGES) {
  test(`#7302 ${language} native typed grouping presentation keeps literal group/citation ownership`, () => {
    clashDiscussion(JSON.stringify({ version: 1, kind: 'clash.groups', groups: [
      { name: 'Source {Model.Name}', explanation: 'Coordinate E1.', citations: ['E1'] },
    ] }));
    const draft = prepareReportDraft('Grouping', language);
    const texts = draft.document.blocks.flatMap(block => block.kind === 'text' ? [renderTemplate(block.text,
      { models: [], activeModelId: null, today: new Date() }).text] : []);
    assert.ok(texts.includes('Source {Model.Name}'));
    assert.ok(texts.includes('Coordinate E1.'));
    const grouping = slot(draft.document, 'narrative:0'); assert.ok(grouping);
    assert.match(grouping.text, /1/);
    assert.doesNotMatch(grouping.text, /\{count\}|\{plural\}/);
    if (language === 'fr') assert.match(grouping.text, /^Regroupement proposé : 1 groupe\./);
    if (language === 'en') assert.match(grouping.text, /^Proposed grouping: 1 group\./);
    assert.deepEqual(draft.citations, ['E1']);
  });
}
