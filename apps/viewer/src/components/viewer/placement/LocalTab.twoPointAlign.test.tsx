/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Two-point align UI state machine (#11505), driven without WebGPU: the
 * pick events the renderer would deliver are fed through the same `capture`
 * entry point `useRepositionPicking` calls on a click. */
import '@/test/setup-dom.js';
import '@/test/section-tool-ready.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState, placementFor } from '@/lib/model-placement/state';
import { modelPointToWorkspacePoint } from '@/lib/model-placement/rotation';
import { useRepositionRuntime, type RepositionRuntime } from '@/lib/model-placement/reposition-runtime';
import type { Translation } from '@/lib/model-placement/translation';
import { ToolOverlays } from '../ToolOverlays';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';
import { LocalTab } from './LocalTab';

let runtime: RepositionRuntime | null = null;
function Probe() { runtime = useRepositionRuntime(); return null; }

function button(ui: HTMLElement, label: string): HTMLButtonElement {
  const el = [...ui.querySelectorAll('button')].find((item) => item.textContent === label);
  assert.ok(el, `button ${label}`); return el;
}
const hasButton = (ui: HTMLElement, label: string) => [...ui.querySelectorAll('button')].some((item) => item.textContent === label);
const promptText = (ui: HTMLElement) => ui.querySelector('fieldset output')?.textContent ?? '';
const readoutText = (ui: HTMLElement) => ui.querySelector('[role="group"][aria-label="Alignment result"]')?.textContent ?? '';
/** What a user's click on the canvas does in align mode. */
function pickPoint(role: 'source' | 'target', point: Translation, modelId = role === 'source' ? 'ifc' : 'scan') {
  assert.ok(runtime, 'runtime is published');
  const next = runtime.align.capture(role, { modelId, point, kind: 'vertex' });
  act(() => runtime!.setRole(next));
}
function pickAll(a: Translation, aPrime: Translation, b: Translation, bPrime: Translation) {
  pickPoint('source', a); pickPoint('target', aPrime); pickPoint('source', b); pickPoint('target', bPrime);
}

describe('two-point align panel (#11505)', () => {
  let ui: HTMLElement;
  beforeEach(() => {
    runtime = null;
    useViewerStore.setState({ ...fixtureModels(fixtureModel('ifc'), { ...fixtureModel('scan'), ifcDataStore: null }),
      editEnabled: true, modelPlacement: emptyPlacementState(), repositionOpen: false, repositionNudge: 0.001, activeTool: 'select' });
    act(() => useViewerStore.getState().openReposition(['ifc']));
    ui = render(<><Probe /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot><LocalTab /></>);
  });
  afterEach(cleanup);

  it('walks the four prompts in order and enables Apply only once the result exists', () => {
    click(button(ui, 'Two-point align'));
    assert.equal(promptText(ui), 'Pick A on the moving models.');
    assert.equal(runtime!.role, 'source');
    assert.equal(button(ui, 'Apply alignment').disabled, true);
    pickPoint('source', [0, 0, 0]);
    assert.equal(promptText(ui), 'Pick A′ on the reference model.');
    assert.equal(runtime!.role, 'target');
    pickPoint('target', [10, 0, 0]);
    assert.equal(promptText(ui), 'Pick B on the moving models, far from A.');
    pickPoint('source', [5, 0, 0]);
    assert.equal(promptText(ui), 'Pick B′ on the reference model.');
    assert.equal(button(ui, 'Apply alignment').disabled, true, 'three picks are not a result');
    pickPoint('target', [10, 5, 0]);
    assert.equal(runtime!.role, null);
    assert.match(promptText(ui), /All four points are picked/);
    assert.equal(button(ui, 'Apply alignment').disabled, false);
  });

  it('shows the readout, applies rotation about A then the move as one undo step', () => {
    click(button(ui, 'Two-point align'));
    // The model is turned +90 deg (X -> Y) and moved so that A lands on A'.
    pickAll([100, 100, 0], [30, -20, 1], [160, 100, 0], [30, 40, 1]);
    assert.match(readoutText(ui), /Rotation \+90\.00° \(about A\)/);
    assert.match(readoutText(ui), /Move ΔX -70\.000 · ΔY -120\.000 · ΔZ 1\.000 m/);
    assert.match(readoutText(ui), /Check: B lands 0 mm from B′ ✓/);
    assert.equal(useViewerStore.getState().modelPlacement.undo.length, 0, 'nothing is applied before Apply');
    click(button(ui, 'Apply alignment'));
    const state = useViewerStore.getState().modelPlacement;
    assert.equal(state.undo.length, 1, 'one undoable step');
    const placed = placementFor(state, 'ifc');
    assert.ok(Math.abs(placed.rotation.angle - Math.PI / 2) < 1e-12);
    // A (a point of the model, at its own frame) now sits on A'.
    const landed = modelPointToWorkspacePoint([100, 100, 0], placed);
    assert.ok(Math.hypot(landed[0] - 30, landed[1] + 20, landed[2] - 1) < 1e-9, `A landed at ${landed}`);
    assert.ok(hasButton(ui, 'Two-point align'), 'the mode ended');
    click(button(ui, 'Undo placement'));
    assert.deepEqual(placementFor(useViewerStore.getState().modelPlacement, 'ifc').translation, [0, 0, 0]);
  });

  it('warns when B lands over 10 mm off B-prime and lists the ratio when lengths differ by over 0.1%', () => {
    click(button(ui, 'Two-point align'));
    pickAll([0, 0, 0], [0, 0, 0], [10, 0, 0], [10.05, 0, 0]);
    assert.match(readoutText(ui), /Check: B lands 50 mm from B′ ⚠/);
    assert.ok(ui.querySelector('[aria-label="Alignment result"]')!.className.includes('amber'), 'warn styling');
    click(button(ui, 'Pick again'));
    pickAll([0, 0, 0], [0, 0, 0], [10, 0, 0], [10.2, 0, 0]);
    assert.match(readoutText(ui), /Plan length ratio \|AB\| \/ \|A′B′\| = 0\.9804/);
  });

  it('reports a degenerate pair instead of a result, and disables Apply', () => {
    click(button(ui, 'Two-point align'));
    pickAll([5, 5, 0], [0, 0, 0], [5, 5, 9], [10, 0, 0]);
    assert.equal(readoutText(ui), '');
    assert.match(ui.querySelector('fieldset [role="alert"]')?.textContent ?? '', /A and B are at the same plan position/);
    assert.equal(button(ui, 'Apply alignment').disabled, true);
  });

  it('copies exactly the displayed readout lines', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
    click(button(ui, 'Two-point align'));
    pickAll([0, 0, 0], [3, 4, 5], [10, 0, 0], [13, 4, 5]);
    await act(async () => { click(button(ui, 'Copy transformation')); });
    assert.deepEqual(written, [[...ui.querySelectorAll('[aria-label="Alignment result"] p')].map((p) => p.textContent).join('\n')]);
    assert.match(written[0], /^Rotation 0\.00° \(about A\)\nMove ΔX 3\.000 · ΔY 4\.000 · ΔZ 5\.000 m\nCheck: B lands 0 mm from B′ ✓$/);
    assert.match(ui.textContent ?? '', /Transformation copied/);
  });

  it('clears picks when the models move under them, and Cancel leaves the placement alone', () => {
    click(button(ui, 'Two-point align'));
    pickPoint('source', [0, 0, 0]);
    act(() => useViewerStore.getState().previewModelTranslation([1, 0, 0]));
    assert.equal(promptText(ui), 'Pick A on the moving models.');
    assert.match(ui.textContent ?? '', /picks were cleared/);
    click(button(ui, 'Cancel align'));
    assert.ok(hasButton(ui, 'Two-point align'));
    assert.equal(runtime!.role, null);
    assert.equal(useViewerStore.getState().modelPlacement.undo.length, 0);
  });

  it('refuses a pick for the wrong role instead of filing it under the wrong point', () => {
    click(button(ui, 'Two-point align'));
    assert.equal(runtime!.align.capture('target', { modelId: 'scan', point: [1, 1, 1], kind: 'point' }), 'target');
    assert.deepEqual(runtime!.align.points, {});
  });

  it('is a distinct mode: choosing the ordinary source pick leaves it', () => {
    click(button(ui, 'Two-point align'));
    pickPoint('source', [0, 0, 0]);
    act(() => runtime!.setRole('source'));
    assert.equal(runtime!.align.active, false);
    assert.deepEqual(runtime!.align.points, {});
  });
});
