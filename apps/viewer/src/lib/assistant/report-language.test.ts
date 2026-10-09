/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { clashDiscussion, typedReport } from '@/test/ai-report-fixture';
import { printDocumentText } from '@/test/document-pdf-text';
import { isStandardFontChar, StandardFontLedger, toStandardFontText, unprintableShare } from '../document/standard-font-text';
import { cancelAssistant } from './conversation';
import { prepareReportDraft } from './report-draft';
import { declaredLanguageDiffers, defaultReportLanguage, reportLanguageInstruction, type ReportLanguage } from './report-language';

const initial = useViewerStore.getState();
afterEach(() => { cancelAssistant(); useViewerStore.setState(initial, true); });

test('glyph safety keeps WinAnsi text, spells known symbols, keeps base letters and reports the rest', () => {
  const german = toStandardFontText('Größe der Wände – „geprüft“ € ≥ 2 m² → OK');
  assert.equal(german.text, 'Größe der Wände – „geprüft“ € >= 2 m² -> OK');
  assert.deepEqual([...german.transliterated.keys()], ['≥', '→']);
  const polish = toStandardFontText('Ściana łazienki, příčka');
  assert.equal(polish.text, 'Sciana lazienki, prícka', 'í is WinAnsi; ř and č keep their base letter');
  const japanese = toStandardFontText('壁 E1\r\n');
  assert.equal(japanese.text, '? E1\n');
  assert.deepEqual([...japanese.replaced], [['壁', 1]]);
  const ledger = new StandardFontLedger();
  assert.equal(ledger.print('Raum 会議室 → Nord'), 'Raum ??? -> Nord');
  assert.equal(ledger.notice(), 'Transliterated for the standard PDF fonts: U+2192 as "->".\n'
    + 'Not printable in the standard PDF fonts and replaced by "?": U+4F1A (1x), U+8B70 (1x), U+5BA4 (1x).');
  assert.ok(unprintableShare('Raum 会議室') > 0.3 && unprintableShare('Wände') === 0);
  assert.equal(isStandardFontChar('\u0081'), false, 'C1 controls are not printable even inside 0x80-0x9F');
  assert.equal(isStandardFontChar('\u0007'), false);
});

test('narrative language is chosen per draft and stated to the provider', () => {
  assert.equal(defaultReportLanguage('de-CH'), 'de');
  assert.equal(defaultReportLanguage('ja'), 'en', 'non-Latin UI languages default to an printable report language');
  assert.match(reportLanguageInstruction('de'), /in German \(de\)/);
  assert.equal(declaredLanguageDiffers('de-CH', 'de'), false);
  assert.equal(declaredLanguageDiffers('en', 'de'), true);
  assert.equal(declaredLanguageDiffers(null, 'de'), false);
});

const NARRATIVES: Array<{ language: ReportLanguage; prose: string; claim: string; printed: RegExp[]; notice?: RegExp; provenance: RegExp }> = [
  { language: 'de', provenance: /Berichtssprache: de · Revision 1/, prose: '## Zusammenfassung\nDie Wände überschneiden sich mit Leitungen – Prüfung nötig [E1].',
    claim: 'Kollision E1 überlappt um 20 mm („hart“).', printed: [/Die Wände überschneiden sich mit Leitungen – Prüfung nötig \[E1\]\./, /Kollision E1 überlappt um 20 mm \(„hart“\)\./] },
  { language: 'fr', provenance: /Langue du rapport : fr · Révision 1/, prose: 'L’écart dépasse la tolérance « 2 mm » ; coordination requise [E1].',
    claim: 'Le conflit E1 se chevauche de 20 mm.', printed: [/L’écart dépasse la tolérance « 2 mm » ; coordination requise \[E1\]\./, /Le conflit E1 se chevauche de 20 mm\./] },
  { language: 'pl', provenance: /Jezyk raportu: pl · Wersja 1/, prose: 'Ściana łazienki koliduje z rurą [E1].', claim: 'Kolizja E1 zachodzi na 20 mm.',
    printed: [/Sciana lazienki koliduje z rura \[E1\]\./, /Kolizja E1 zachodzi na 20 mm\./], notice: /Transliteracja dla standardowych czcionek PDF:.*U\+015A jako "S"/ },
  { language: 'cs', provenance: /Jazyk zprávy: cs · Revize 1/, prose: 'Příčka koliduje s potrubím [E1].', claim: 'Kolize E1 se překrývá o 20 mm.',
    printed: [/Prícka koliduje s potrubím \[E1\]\./, /Kolize E1 se prekrývá o 20 mm\./], notice: /U\+0159 jako "r"/ },
];

// #6918: multilingual narrative verified in the real PDF. Invariant: every document character is
// printable in the standard fonts, so the preview (document text) and the PDF read the same.
for (const sample of NARRATIVES) {
  test(`${sample.language} narrative and claims print verbatim or with a stated transliteration`, async () => {
    clashDiscussion(typedReport(sample.prose, [{ text: sample.claim, facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] }], sample.language));
    const draft = prepareReportDraft(`Bericht ${sample.language}`, sample.language);
    assert.equal(draft.claims[0].status, 'supported');
    const text = draft.document.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n');
    assert.ok([...text].every(isStandardFontChar), 'document text is printable as stored');
    if (sample.notice) assert.match(text, sample.notice);
    else assert.doesNotMatch(text, /Transliterated|Not printable/);
    const printed = await printDocumentText(draft.document);
    assert.deepEqual(printed.unresolved, []);
    for (const expected of sample.printed) assert.match(printed.text, expected);
    assert.match(printed.text, sample.provenance);
  });
}

test('a mostly unprintable narrative is refused instead of printing question marks', () => {
  clashDiscussion('壁と配管が干渉しています。調整が必要です。衝突は三件あります。[E1]');
  assert.throws(() => prepareReportDraft('Report', 'en'), /Choose a Latin-script report language/);
});
