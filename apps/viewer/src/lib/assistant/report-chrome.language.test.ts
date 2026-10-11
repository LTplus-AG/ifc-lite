/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { clashDiscussion, typedReport } from '@/test/ai-report-fixture';
import { printDocumentText } from '@/test/document-pdf-text';
import { cancelAssistant } from './conversation';
import { prepareReportDraft } from './report-draft';

const initial = useViewerStore.getState();
afterEach(() => { cancelAssistant(); useViewerStore.setState(initial, true); });

// P08: the native clash invariant is -0.02 m. Claims independently convert it
// to -20 mm, and the real document PDF retains that source fact/citation. No
// provider request or native-speaker assessment is performed by this test.
for (const sample of [
  { language: 'fr' as const, prose: 'Coordination requise [E1].', claim: 'Le conflit E1 se chevauche de 20 mm.' },
  { language: 'de' as const, prose: 'Koordination erforderlich [E1].', claim: 'Kollision E1 überlappt um 20 mm.' },
]) {
  test(`P08 ${sample.language} native report chrome follows the selected report language in document and PDF`, async () => {
    clashDiscussion(typedReport(sample.prose, [{ text: sample.claim,
      facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] }], sample.language));
    const draft = prepareReportDraft(`Report ${sample.language}`, sample.language);
    assert.equal(draft.claims[0].status, 'supported');
    assert.equal(draft.document.aiReport?.language, sample.language);
    const printed = await printDocumentText(draft.document);
    assert.deepEqual(printed.unresolved, []);
    assert.ok(printed.text.includes(sample.prose));
    assert.ok(printed.text.includes(sample.claim));
    assert.match(printed.text, /E1/);
    assert.match(printed.text, /E1 distance: -0\.02 m/);
    const chrome = draft.document.blocks.flatMap(block => block.kind === 'text' && block.aiProvenance
      && !block.aiProvenance.slot.startsWith('narrative:') && !block.aiProvenance.slot.startsWith('claim:')
      ? [block.text] : []).join('\n');
    assert.doesNotMatch(chrome + '\nPDF:\n' + printed.text,
      /Narrative for review|Claims checked against captured evidence|Supported by captured data|Captured evidence appendix|Narrative language:/,
      'Native chrome must use the selected report language; native IFC fields/values and E1 citations stay unchanged.');
  });
}
