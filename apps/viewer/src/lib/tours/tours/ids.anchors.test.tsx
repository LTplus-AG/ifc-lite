/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS tour reaches its in-panel anchors (#5608). Since #5138 the Data
 * validation panel opens on two entry cards, and Load IDS File / Run
 * Validation only mount on its IDS side, so every IDS step after "open the
 * panel" broke at runtime. Each step here is prepared the way the tour engine
 * prepares it, against the real panel in the state a first-time user sees.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { IDSDocument } from '@ifc-lite/ids';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { ValidationPanel } from '@/components/viewer/validation/ValidationPanel.js';
import { anchorSelector } from '../anchors.js';
import { IDS_TOUR } from './ids.js';

function step(id: string) {
  const found = IDS_TOUR.steps.find((s) => s.id === id);
  assert.ok(found, `ids tour has a ${id} step`);
  return found;
}

/** The step's anchor selector (every step checked here is anchored). */
function selectorOf(id: string): string {
  const anchor = step(id).anchor;
  assert.ok(anchor, `${id} is an anchored step`);
  return anchorSelector(anchor);
}

async function prepare(id: string): Promise<void> {
  await act(async () => {
    await step(id).prepare?.(useViewerStore);
  });
}

function idsDocumentFixture(): IDSDocument {
  return {
    info: { title: 'Tour anchor fixture', version: '1.0' },
    specifications: [{
      id: 'spec-a', name: 'Wall requirements', ifcVersions: ['IFC4'],
      applicability: { facets: [] }, requirements: [],
    }],
  };
}

const initial = useViewerStore.getState();

afterEach(() => {
  cleanup();
  setValidationSourceChoice(null);
  useViewerStore.setState({ ...initial, idsDocument: null, idsValidationReport: null, validationSource: null });
});

describe('IDS tour anchors (#5608)', () => {
  it('load-spec finds Load IDS File on a fresh panel, not the entry cards', async () => {
    const ui = render(<ValidationPanel />);
    await prepare('load-spec');
    assert.ok(ui.querySelector(selectorOf('load-spec')), 'Load IDS File anchor is mounted');
  });

  it('run-validation finds Run Validation once a spec is loaded', async () => {
    const ui = render(<ValidationPanel />);
    await prepare('load-spec');
    act(() => {
      useViewerStore.setState({ idsDocument: idsDocumentFixture() });
    });
    await prepare('run-validation');
    assert.ok(ui.querySelector(selectorOf('run-validation')), 'Run Validation anchor is mounted');
  });

  it('a panel the tour opens after preparing (open step skipped) mounts on its IDS side', async () => {
    await prepare('load-spec');
    const ui = render(<ValidationPanel />);
    assert.ok(ui.querySelector(selectorOf('load-spec')), 'Load IDS File anchor is mounted');
  });
});
