/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { render, click, type, cleanup } from '@/test/render.js';
import { AppearancePanelView } from './AppearancePanelView.js';
import type { AppearancePanelViewProps, AppearanceDraftSettings } from './types.js';

afterEach(cleanup);
function props(overrides: Partial<AppearancePanelViewProps> = {}): AppearancePanelViewProps {
  return {
    models: [{ id: 'model', name: 'Building.ifc' }], modelId: 'model', onModelChange() {},
    sources: [{ id: 'image', name: 'Brick.png', width: 512, height: 512 }], sourceId: 'image', onSourceChange() {}, onUpload() {},
    scope: { kind: 'model' }, onScopeChange() {}, classes: [{ value: 'IfcWall', label: 'IfcWall' }], types: [{ id: 42, name: 'External wall' }],
    selectionCount: 2, affectedCount: 12, excludedCount: 1, exclusions: ['One object has no supported surface geometry.'],
    settings: { kind: 'planar', plane: 'xy', repeatU: 1, repeatV: 1, tileWidth: 1, tileHeight: 1, tileDepth: 1,
      rotationDegrees: 0, offsetU: 0, offsetV: 0, offsetW: 0, repeatS: true, repeatT: true },
    onSettingsChange() {}, status: 'ready', canApply: true, canDiscard: true, hasPreview: true, showingOriginal: false,
    onCompareChange() {}, onApply() {}, onDiscard() {}, ...overrides,
  };
}
function button(ui: HTMLElement, text: string) {
  const element = [...ui.querySelectorAll('button')].find(element => element.textContent?.trim() === text);
  assert.ok(element, `Button ${text} exists`); return element;
}
function select(ui: HTMLElement, label: string, value: string) {
  const element = ui.querySelector(`select[aria-label="${label}"]`);
  assert.ok(element instanceof HTMLSelectElement);
  act(() => { element.value = value; element.dispatchEvent(new window.Event('change', { bubbles: true })); });
}

// #4243: exercise mounted controls, including real File events and disabled actions.
it('uploads the chosen File and supports dropping a source without a separate import dialog', () => {
  const uploaded: File[] = [];
  const ui = render(<AppearancePanelView {...props({ onUpload: file => uploaded.push(file) })} />);
  const file = new window.File([new Uint8Array([137, 80, 78, 71])], 'Brick.png', { type: 'image/png' });
  const transfer = new window.DataTransfer(); transfer.items.add(file);
  const picker = ui.querySelector('input[type="file"]');
  assert.ok(picker instanceof HTMLInputElement);
  Object.defineProperty(picker, 'files', { value: transfer.files, configurable: true });
  act(() => { picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(uploaded[0], file);
  assert.equal(picker.value, '');
  const dropZone = picker.parentElement;
  assert.ok(dropZone);
  const drop = new window.Event('drop', { bubbles: true, cancelable: true });
  // happy-dom's DragEvent constructor does not install dataTransfer yet.
  Object.defineProperty(drop, 'dataTransfer', { value: transfer });
  act(() => { dropZone.dispatchEvent(drop); });
  assert.equal(uploaded.length, 2);
  assert.equal(uploaded[1], file);
});

it('uses numeric physical units, blocks invalid local input and forwards valid changes', () => {
  const patches: Partial<AppearanceDraftSettings>[] = [];
  let applies = 0;
  const ui = render(<AppearancePanelView {...props({ onSettingsChange: patch => patches.push(patch), onApply: () => applies++ })} />);
  const width = ui.querySelector('input[aria-label="Tile width (m)"]');
  assert.ok(width instanceof HTMLInputElement);
  type(width, '2.5');
  assert.deepEqual(patches.at(-1), { tileWidth: 2.5 });
  click(button(ui, 'Apply')); assert.equal(applies, 1);
  type(width, '');
  assert.equal(button(ui, 'Apply').disabled, true);
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /valid number/);
  type(width, '-2');
  assert.equal(button(ui, 'Apply').disabled, true);
  assert.deepEqual(patches.at(-1), { tileWidth: 2.5 });
  click(button(ui, 'Discard'));
  assert.equal(button(ui, 'Apply').disabled, false);
  assert.equal((ui.querySelector('input[aria-label="Tile width (m)"]') as HTMLInputElement).value, '1');
});

it('keeps UV repeat labels dimensionless and forwards exact type scope identifiers', () => {
  const scopes: AppearancePanelViewProps['scope'][] = [];
  const settings = props().settings;
  const ui = render(<AppearancePanelView {...props({ settings: { ...settings, kind: 'existingUv' }, onScopeChange: scope => scopes.push(scope) })} />);
  assert.ok(ui.querySelector('input[aria-label="Repeat U (×)"]'));
  assert.equal(ui.querySelector('input[aria-label="Tile width (m)"]'), null);
  select(ui, 'Appearance scope', 'type');
  assert.deepEqual(scopes, [{ kind: 'type', typeId: 42 }]);
  assert.match(ui.textContent ?? '', /12 objects affected/);
  assert.match(ui.textContent ?? '', /1 excluded/);
});

it('never applies a stale, busy, unavailable or empty preview even if the caller left canApply true', () => {
  for (const change of [
    { status: 'stale' as const }, { status: 'preparing' as const }, { status: 'applying' as const },
    { affectedCount: 0 }, { hasPreview: false }, { unavailableReason: 'This model is still loading.' }, { sourceId: null },
  ]) {
    const ui = render(<AppearancePanelView {...props(change)} />);
    assert.equal(button(ui, 'Apply').disabled, true);
  }
});

it('routes comparison and discard through the controller while keeping errors visible', () => {
  const compared: boolean[] = []; let discards = 0;
  const ui = render(<AppearancePanelView {...props({ status: 'error', statusMessage: 'Resize this image to fit the decoded image budget.',
    onCompareChange: original => compared.push(original), onDiscard: () => discards++ })} />);
  click(button(ui, 'Compare original')); click(button(ui, 'Discard'));
  assert.deepEqual(compared, [true]); assert.equal(discards, 1);
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /Resize this image/);
});

it('removes only the selected source through the controller callback', () => {
  const removed: string[] = [];
  const ui = render(<AppearancePanelView {...props({ onRemoveSource: id => removed.push(id) })} />);
  const remove = ui.querySelector('button[aria-label="Remove source image"]');
  assert.ok(remove); click(remove);
  assert.deepEqual(removed, ['image']);
});

it('offers an explicit supported-object scope change instead of silently narrowing the model', () => {
  let confirmed = 0;
  const ui = render(<AppearancePanelView {...props({ onUseSupported: () => confirmed++ })} />);
  assert.equal(confirmed, 0);
  click(button(ui, 'Use supported objects')); assert.equal(confirmed, 1);
  const empty = render(<AppearancePanelView {...props({ affectedCount: 0, onUseSupported: () => confirmed++ })} />);
  assert.equal([...empty.querySelectorAll('button')].some(button => button.textContent === 'Use supported objects'), false);
});

it('can reuse the remaining library image when no source is selected', () => {
  const chosen: string[] = [];
  const ui = render(<AppearancePanelView {...props({ sourceId: null, onSourceChange: id => chosen.push(id) })} />);
  select(ui, 'Reuse an image', 'image');
  assert.deepEqual(chosen, ['image']);
});

it('Discard restores the last valid PDF calibration instead of clearing its error around an empty distance (#4260)', () => {
  const ui = render(<AppearancePanelView {...props({ calibration: {
    thumbnailUrl: 'blob:page', onChange() {}, value: { sourcePoints: [[0, 0], [100, 0]], distanceMetres: 1 },
    sourceKey: 'page:1', frame: { rasterSize: [100, 100], rasterToSource: [1, 0, 0, -1, 0, 100] },
  } })} />);
  const distance = ui.querySelector('input[aria-label="Distance A–B (m)"]');
  assert.ok(distance instanceof HTMLInputElement);
  type(distance, '');
  assert.equal(button(ui, 'Apply').disabled, true);
  click(button(ui, 'Discard'));
  const restored = ui.querySelector('input[aria-label="Distance A–B (m)"]');
  assert.ok(restored instanceof HTMLInputElement);
  assert.equal(restored.value, '1');
  assert.equal(button(ui, 'Apply').disabled, false);
});

it('allows cancelling cooperative Apply while preventing a second Apply (#4336)', () => {
  const controller = new AbortController();
  const ui = render(<AppearancePanelView {...props({ status: 'applying', onDiscard: () => controller.abort() })} />);
  assert.equal(button(ui, 'Apply').disabled, true);
  assert.equal(button(ui, 'Discard').disabled, false);
  click(button(ui, 'Discard'));
  assert.equal(controller.signal.aborted, true);
});


it('switches source intent without replacing the source picker or requiring an IFC target for references (#4308)', () => {
  let placements = 0;
  function Workspace() {
    const [intent, setIntent] = useState<'apply' | 'reference'>('apply');
    return <AppearancePanelView {...props({ intent, onIntentChange: setIntent, modelId: null,
      affectedCount: 0, onApply: () => { placements++; }, calibration: {
        sourceKey: 'image', frame: { rasterSize: [512, 512], rasterToSource: [1, 0, 0, 1, 0, 0] },
        thumbnailUrl: 'blob:image', value: { sourcePoints: [[0, 0], [512, 0]], distanceMetres: 10 }, onChange() {},
      } })} />;
  }
  const ui = render(<Workspace />);
  const picker = ui.querySelector('input[type="file"]');
  assert.equal(button(ui, 'Apply').disabled, true, 'IFC application still needs its target');
  click(button(ui, 'Place as reference'));
  assert.equal(ui.querySelector('input[type="file"]'), picker, 'switching intent keeps the same source control mounted');
  assert.equal(ui.querySelector('select[aria-label="Appearance model"]'), null);
  const distance = ui.querySelector('input[aria-label="Distance A–B (m)"]');
  assert.ok(distance instanceof HTMLInputElement);
  assert.equal(distance.value, '10');
  assert.equal(button(ui, 'Place reference').disabled, false);
  click(button(ui, 'Place reference'));
  assert.equal(placements, 1);
  click(button(ui, 'Apply to IFC'));
  assert.ok(ui.querySelector('select[aria-label="Appearance model"]'));
  assert.equal(ui.querySelector('input[type="file"]'), picker);
});

// A source can enter reference mode after a tiled/UV appearance draft (#4308).
it('always exposes planar alignment for calibrated sources even after box or UV mapping', () => {
  for (const kind of ['box', 'existingUv'] as const) {
    const patches: Partial<AppearanceDraftSettings>[] = [];
    const ui = render(<AppearancePanelView {...props({ intent: 'reference',
      settings: { ...props().settings, kind }, onSettingsChange: patch => patches.push(patch),
      calibration: { thumbnailUrl: 'blob:page', onChange() {},
        value: { sourcePoints: [[0, 0], [100, 0]], distanceMetres: 1 },
        sourceKey: 'page:1', frame: { rasterSize: [100, 100], rasterToSource: [1, 0, 0, 1, 0, 0] } },
    })} />);
    select(ui, 'Projection plane', 'xz');
    assert.deepEqual(patches.at(-1), { plane: 'xz' });
    const rotation = ui.querySelector('input[aria-label="Rotation (°)"]');
    assert.ok(rotation instanceof HTMLInputElement);
    type(rotation, '45');
    assert.deepEqual(patches.at(-1), { rotationDegrees: 45 });
    assert.equal(ui.querySelector('select[aria-label="Texture mapping"]'), null);
    assert.equal(ui.querySelector('input[aria-label="Repeat U (×)"]'), null);
    assert.equal(ui.querySelector('input[aria-label="Tile X (m)"]'), null);
  }
});
