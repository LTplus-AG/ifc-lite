/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { act } from 'react';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { ViewportOverlays } from './ViewportOverlays.js';

/** Text of the HUD's top-left region, where status chips live. */
function topLeftText(): string {
  const region = document.querySelector('[data-hud-region="top-left"]');
  assert.ok(region, 'ViewportOverlays mounts the HUD host');
  return region!.textContent ?? '';
}

function setEdit(on: boolean): void {
  act(() => useViewerStore.getState().setEditEnabled(on));
}

beforeEach(() => {
  useViewerStore.setState({ editEnabled: false, activeTool: 'select' });
});

afterEach(() => {
  setEdit(false);
  cleanup();
});

describe('Edit mode HUD chip (#5489)', () => {
  it('shows "Editing · <model>" in the top-left HUD region only while edit mode is on', () => {
    useViewerStore.setState({ ...fixtureModels(fixtureModel('AC20-FZK-Haus.ifc')) });
    render(<ViewportOverlays />);

    assert.doesNotMatch(topLeftText(), /Editing/, 'no chip while viewing');

    setEdit(true);
    assert.match(topLeftText(), /Editing · AC20-FZK-Haus\.ifc/);

    setEdit(false);
    assert.doesNotMatch(topLeftText(), /Editing/, 'the chip leaves with edit mode');
  });

  it('names the active model when several are loaded, and follows a change of active model', () => {
    useViewerStore.setState({
      ...fixtureModels(
        fixtureModel('architecture.ifc'),
        fixtureModel('structure.ifc', { idOffset: 1_000_000 }),
      ),
    });
    render(<ViewportOverlays />);
    setEdit(true);
    assert.match(topLeftText(), /Editing · architecture\.ifc/);

    act(() => useViewerStore.setState({ activeModelId: 'structure.ifc' }));
    assert.match(topLeftText(), /Editing · structure\.ifc/);
    assert.doesNotMatch(topLeftText(), /architecture/);
  });

  it('says only "Editing" when several models are loaded and none is active, rather than guess', () => {
    useViewerStore.setState({
      ...fixtureModels(fixtureModel('a.ifc'), fixtureModel('b.ifc', { idOffset: 1_000_000 })),
      activeModelId: null,
    });
    render(<ViewportOverlays />);
    setEdit(true);
    const text = topLeftText();
    assert.match(text, /Editing/);
    assert.doesNotMatch(text, /·|a\.ifc|b\.ifc/);
  });
});
