/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { resolveEnglish } from '@/i18n/registry';
import { panelTitleKey, type WorkspacePanelId } from '@/lib/panels/registry';
import { ADAPTER_GROUPS, ADAPTERS, UNSUPPORTED_PANELS } from '@/lib/assistant/adapters/registry';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { summarizeClashes, type Clash } from '@ifc-lite/clash';
import { AssistantPanel } from './AssistantPanel';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

// #6833: the picker lists every registered source in its group with the live native
// status its adapter reports, and explains every panel that has nothing to discuss.
test('the source picker shows every source grouped with its live readiness and every boundary with its reason', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  const ui = render(<AssistantPanel />);
  for (const group of ADAPTER_GROUPS) {
    const section = ui.querySelector(`section[aria-label="${resolveEnglish(group.labelKey)}"]`);
    const members = ADAPTERS.filter(adapter => adapter.group === group.id);
    assert.equal(!!section, members.length > 0, `${group.id} section rendered iff it has sources`);
    for (const adapter of members) {
      const row = section?.querySelector(`li[data-source="${adapter.id}"]`);
      assert.ok(row, `${adapter.id} is listed under ${group.id}`);
      const readiness = adapter.readiness(useViewerStore.getState());
      assert.match(row.textContent ?? '', new RegExp(escape(resolveEnglish(readiness.status.labelKey, readiness.status.params))), `${adapter.id} shows its status`);
      assert.equal(!!row.querySelector(`button[aria-label="Discuss ${resolveEnglish(adapter.titleKey)}"]`), readiness.ready, `${adapter.id} offers Discuss only when ready`);
      assert.ok(row.querySelector(`button[aria-label="Open ${resolveEnglish(adapter.titleKey)}"]`), `${adapter.id} can open its producer`);
    }
  }
  const boundaries = Object.entries(UNSUPPORTED_PANELS) as Array<[WorkspacePanelId, NonNullable<typeof UNSUPPORTED_PANELS[WorkspacePanelId]>]>;
  for (const [panel, reason] of boundaries) {
    const row = ui.querySelector(`li[data-boundary="${panel}"]`);
    assert.ok(row, `${panel} boundary is listed`);
    assert.match(row.textContent ?? '', new RegExp(escape(resolveEnglish(panelTitleKey(panel)))));
    assert.match(row.textContent ?? '', new RegExp(escape(resolveEnglish(reason))));
  }
});

test('readiness follows the native store live and Discuss attaches the source', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  const ui = render(<AssistantPanel />);
  const clashRow = () => ui.querySelector('li[data-source="clash"]')!;
  assert.match(clashRow().textContent ?? '', /Not run yet/);
  const clash: Clash = { id: 'c1', rule: 'coordination', status: 'hard', severity: 'major', distance: -0.02, distanceKind: 'estimate',
    a: { model: 'm', key: 'wall', ref: 1, tag: 'IfcWall' }, b: { model: 'm', key: 'pipe', ref: 2, tag: 'IfcPipeSegment' },
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
  const result = { clashes: [clash], summary: summarizeClashes([clash]), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true } };
  act(() => useViewerStore.setState({ clashResult: result, clashRawResult: result }));
  assert.match(clashRow().textContent ?? '', /1 finding/);
  click(clashRow().querySelector('button[aria-label="Discuss Clash detection"]')!);
  assert.equal(useAssistant.getState().snapshot?.source, 'clash');
});

function escape(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
