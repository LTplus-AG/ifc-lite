/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { clashDiscussion, seedClashResult, typedReport } from '@/test/ai-report-fixture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cancelAssistant } from '@/lib/assistant/conversation';
import { prepareReportDraft } from '@/lib/assistant/report-draft';
import type { DocumentSpec, TextBlock } from '@/lib/document/types';
import { AiReportRefresh } from './AiReportRefresh';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); });

// #6918: the saved-report control recaptures the native source, lists edited blocks the refresh
// would change, keeps them unless the reviewer ticks one, and reports the outcome accessibly.
test('mounted refresh lists the conflicting human edit, keeps it by default and replaces it only when ticked', () => {
  clashDiscussion(typedReport('Two findings [E1].', [{ text: 'c1 overlaps by 35 mm.', facts: [{ citation: 'E2', field: 'distance', value: -35, unit: 'mm' }] }]));
  const saved = prepareReportDraft('Saved report').document;
  const caption = saved.blocks.find((block): block is TextBlock => block.kind === 'text' && block.aiProvenance?.slot === 'claim-facts:C1')!;
  const document: DocumentSpec = { ...saved, blocks: saved.blocks.map(block => block.id === caption.id ? { ...caption, text: 'Checked on site.' } : block) };
  seedClashResult([-0.02, -0.04, -0.05]);
  const applied: DocumentSpec[] = [];
  const ui = render(<AiReportRefresh document={document} onChange={next => applied.push(next)} />);
  const section = ui.querySelector('section[aria-label="Refresh evidence"]')!;
  assert.match(section.textContent ?? '', /AI report · English · revision 1/);
  assert.match(section.textContent ?? '', /Text blocks: \d+ AI-generated, 1 edited by people\./);
  const button = (text: string) => [...section.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text)!;
  click(button('Refresh evidence'));
  assert.match(section.textContent ?? '', /C1: Supported by data → Contradicted; 1 changed, 0 missing/);
  const conflict = section.querySelector('[data-conflict="claim-facts:C1"]')!;
  assert.match(conflict.textContent ?? '', /Your text.*Checked on site\..*Regenerated text.*claimed -35 mm, captured -0\.04 m/s);
  click(button('Apply refresh'));
  assert.equal(applied.length, 1);
  assert.equal(applied[0].blocks.find(block => block.id === caption.id)?.kind === 'text'
    && (applied[0].blocks.find(block => block.id === caption.id) as TextBlock).text, 'Checked on site.');
  assert.equal(section.querySelector('[role="status"]')?.textContent, 'Evidence refreshed. Changed and missing facts are flagged in the document.');
  click(button('Refresh evidence'));
  const tick = section.querySelector<HTMLInputElement>('[data-conflict="claim-facts:C1"] input[type="checkbox"]')!;
  assert.equal(tick.closest('label')?.textContent, 'Replace my edit with the regenerated text');
  act(() => tick.click());
  click(button('Apply refresh'));
  assert.match((applied[1].blocks.find(block => block.id === caption.id) as TextBlock).text, /captured -0\.04 m/);
});

test('refresh reports an unavailable native result as an alert and changes nothing', () => {
  clashDiscussion('Answer [E1].');
  const saved = prepareReportDraft('Saved report').document;
  useViewerStore.setState({ clashResult: null, clashRawResult: null });
  const applied: DocumentSpec[] = [];
  const ui = render(<AiReportRefresh document={saved} onChange={next => applied.push(next)} />);
  click([...ui.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === 'Refresh evidence')!);
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /No native result is available/);
  assert.equal(applied.length, 0);
});

// Review of #6973: refusals raised in lib/ reach the reviewer in the viewer language, and a refresh
// against other models than the report was drafted from says so before it is applied.
test('an out-of-date native result is refused in the viewer language, and changed models are flagged', () => {
  useViewerStore.setState(fixtureModels({ ...fixtureModel('m1'), sourceFingerprint: 'rev-a' }));
  clashDiscussion('Answer [E1].');
  const saved = prepareReportDraft('Saved report').document;
  act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
  const applied: DocumentSpec[] = [];
  const ui = render(<AiReportRefresh document={saved} onChange={next => applied.push(next)} />);
  const refresh = () => click([...ui.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === 'Refresh evidence')!);
  refresh();
  assert.equal(ui.querySelector('[role="alert"]')?.textContent,
    'The native result is out of date: the model changed after it was run. Run it again in its panel, then refresh evidence.');
  assert.equal(ui.querySelector('[role="note"]'), null);
  act(() => { useViewerStore.setState(fixtureModels({ ...fixtureModel('m1'), sourceFingerprint: 'rev-b' })); seedClashResult([-0.02, -0.035, -0.05]); });
  refresh();
  assert.equal(ui.querySelector('[role="alert"]'), null);
  assert.equal(ui.querySelector('[role="note"]')?.textContent,
    'The loaded models differ from those this report was drafted against. Claims will be re-checked against the loaded models.');
  assert.equal(applied.length, 0);
});
