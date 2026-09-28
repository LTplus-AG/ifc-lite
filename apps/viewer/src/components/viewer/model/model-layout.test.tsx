/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's default layout rule (#6232 M2.4): Plan ‖ 3D only
 * where the 3D pane keeps the width its HUD needs (measured, see
 * `model-layout.ts`), measured on the split's own width (sidebar and
 * hierarchy already paid for); an explicit pick is kept; a split with no
 * room for both panes shows 3D alone and never squeezes the 3D pane.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { MODEL_3D_MIN_PX, PLAN_MIN_PX, effectiveModelLayout, planPaneWidth, splitFits } from './model-layout';
import { ModelWorkspaceSplit } from './ModelWorkspaceSplit';

const NEED = MODEL_3D_MIN_PX + PLAN_MIN_PX + 6;

describe('effectiveModelLayout (#6232 M2.4)', () => {
  it("'auto' opens Plan ‖ 3D only when both panes fit, else 3D alone", () => {
    assert.equal(effectiveModelLayout('auto', NEED), 'split');
    assert.equal(effectiveModelLayout('auto', NEED - 1), '3d');
    assert.equal(splitFits(NEED - 1), false);
  });

  it('an explicit pick is kept while it fits; a split without room shows 3D, a 3D pick stays 3D', () => {
    assert.equal(effectiveModelLayout('plan', 1600), 'plan');
    assert.equal(effectiveModelLayout('split', 1600), 'split');
    assert.equal(effectiveModelLayout('3d', 4000), '3d');
    assert.equal(effectiveModelLayout('split', NEED - 1), '3d');
    assert.equal(effectiveModelLayout('plan', NEED - 1), '3d');
  });

  it('the plan pane never leaves the 3D pane below its HUD minimum', () => {
    for (const width of [NEED, 1200, 1600, 2400]) {
      for (const layout of ['split', 'plan'] as const) {
        const plan = planPaneWidth(layout, width);
        assert.ok(width - plan - 6 >= MODEL_3D_MIN_PX, `${layout}@${width}: 3D gets ${width - plan - 6}`);
        assert.ok(plan >= PLAN_MIN_PX, `${layout}@${width}: plan gets ${plan}`);
      }
    }
    assert.equal(planPaneWidth('split', 2400), 960, 'Split is 40/60 when there is room');
    assert.equal(planPaneWidth('plan', 2400), 2400 - MODEL_3D_MIN_PX - 6, 'Plan: the 3D pane at its minimum');
  });
});

/** Make the split's own element report `width`, as a narrower window (or wider side panels) would. */
function splitWidth(width: number): () => void {
  const proto = window.Element.prototype as unknown as { getBoundingClientRect(this: Element): DOMRect };
  const real = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Element) {
    const r = real.call(this);
    return this.hasAttribute('data-model-split-width') ? ({ ...r, width, right: r.left + width } as DOMRect) : r;
  };
  return () => { proto.getBoundingClientRect = real; };
}

describe('ModelWorkspaceSplit applies the rule (#6232 M2.4)', () => {
  let restore: (() => void) | null = null;
  beforeEach(async () => {
    await seedModelingSession();
    localStorage.removeItem('ifc-lite:model-layout');
    useViewerStore.setState({ modelLayout: 'auto' });
    assert.ok(useViewerStore.getState().enterModelWorkspace());
  });
  afterEach(() => {
    restore?.();
    restore = null;
    useViewerStore.getState().exitModelWorkspace();
    cleanup();
  });

  it('never picked, wide enough: the plan shows beside 3D', () => {
    restore = splitWidth(1280);
    const ui = render(<ModelWorkspaceSplit><div data-probe-3d /></ModelWorkspaceSplit>);
    assert.ok(ui.querySelector('[data-plan-view]'));
    assert.equal(ui.querySelector('[data-model-layout]')?.getAttribute('data-model-layout'), 'split');
  });

  it('never picked, too narrow: 3D alone, the plan one click away once there is room', () => {
    restore = splitWidth(NEED - 1);
    const ui = render(<ModelWorkspaceSplit><div data-probe-3d /></ModelWorkspaceSplit>);
    assert.equal(ui.querySelector('[data-plan-view]'), null);
    const strip = ui.querySelector<HTMLButtonElement>('[data-model-show-plan]')!;
    assert.ok(strip.disabled, 'no room: the strip says why instead of doing nothing');
    assert.equal(useViewerStore.getState().modelLayout, 'auto', 'nothing was persisted');
  });

  it('an explicit 3D pick is kept where Split would fit', () => {
    act(() => useViewerStore.getState().setModelLayout('3d'));
    restore = splitWidth(1600);
    const ui = render(<ModelWorkspaceSplit><div data-probe-3d /></ModelWorkspaceSplit>);
    assert.equal(ui.querySelector('[data-plan-view]'), null);
    assert.equal(ui.querySelector<HTMLButtonElement>('[data-model-show-plan]')?.disabled, false);
  });
});
